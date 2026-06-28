import { useEffect, useMemo, useRef, useState } from 'react'
import type { Machine, RunnerImportableSessionSummary, RunnerImportFlavor, RunnerImportSessionResult } from '@/types/api'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

const ALL_WORKDIR_FILTER = '__all__'
const SESSION_LIST_PAGE_SIZE = 25

function formatTime(value: number): string | null {
    if (!Number.isFinite(value)) return null
    return new Date(value).toLocaleString()
}

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function getSessionCwd(session: RunnerImportableSessionSummary): string | null {
    const cwd = session.cwd?.trim()
    return cwd ? cwd : null
}

function getFlavorLabel(flavor: RunnerImportFlavor): string {
    switch (flavor) {
        case 'claude':
            return 'Claude Code'
        case 'codex':
            return 'Codex'
        case 'opencode':
            return 'OpenCode'
    }
}

export function RunnerSessionImportDialog(props: {
    isOpen: boolean
    onClose: () => void
    machines: Machine[]
    selectedMachineId: string | null
    onMachineChange: (machineId: string) => void
    selectedFlavor: RunnerImportFlavor
    onFlavorChange: (flavor: RunnerImportFlavor) => void
    sessions: RunnerImportableSessionSummary[]
    isLoading: boolean
    isRefreshing: boolean
    isPending: boolean
    onReload: () => void
    failures?: RunnerImportSessionResult[]
    refreshError?: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
}) {
    const {
        isOpen,
        onClose,
        machines,
        selectedMachineId,
        onMachineChange,
        selectedFlavor,
        onFlavorChange,
        sessions,
        isLoading,
        isRefreshing,
        isPending,
        onReload,
        failures = [],
        refreshError = null,
        onConfirm
    } = props
    const { t } = useTranslation()
    const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])
    const [workdirFilter, setWorkdirFilter] = useState(ALL_WORKDIR_FILTER)
    const [pageIndex, setPageIndex] = useState(0)
    const wasOpenRef = useRef(false)

    const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds), [selectedSessionIds])
    const workdirOptions = useMemo(() => {
        const directories = new Set<string>()
        for (const session of sessions) {
            const cwd = getSessionCwd(session)
            if (cwd) directories.add(cwd)
        }
        return Array.from(directories).sort((a, b) => a.localeCompare(b))
    }, [sessions])
    const filteredSessions = useMemo(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return sessions
        return sessions.filter((session) => getSessionCwd(session) === workdirFilter)
    }, [sessions, workdirFilter])
    const totalPages = Math.max(1, Math.ceil(filteredSessions.length / SESSION_LIST_PAGE_SIZE))
    const pageSessions = useMemo(() => {
        const start = pageIndex * SESSION_LIST_PAGE_SIZE
        return filteredSessions.slice(start, start + SESSION_LIST_PAGE_SIZE)
    }, [filteredSessions, pageIndex])
    const failureBySessionId = useMemo(() => {
        const map = new Map<string, string>()
        for (const failure of failures) {
            if (failure.error) map.set(failure.agentSessionId, failure.error)
        }
        return map
    }, [failures])
    const failedImportResults = useMemo(
        () => failures.filter((failure): failure is RunnerImportSessionResult & { error: string } => Boolean(failure.error)),
        [failures]
    )

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            wasOpenRef.current = true
            setSelectedSessionIds([])
            setWorkdirFilter(ALL_WORKDIR_FILTER)
            setPageIndex(0)
            return
        }

        if (!isOpen && wasOpenRef.current) {
            wasOpenRef.current = false
            setSelectedSessionIds([])
            setWorkdirFilter(ALL_WORKDIR_FILTER)
            setPageIndex(0)
        }
    }, [isOpen])

    useEffect(() => {
        setSelectedSessionIds((current) => current.filter((id) => sessions.some((session) => session.id === id)))
    }, [sessions])

    useEffect(() => {
        if (workdirFilter === ALL_WORKDIR_FILTER) return
        if (workdirOptions.includes(workdirFilter)) return
        setWorkdirFilter(ALL_WORKDIR_FILTER)
    }, [workdirFilter, workdirOptions])

    useEffect(() => {
        setPageIndex(0)
    }, [selectedMachineId, selectedFlavor, workdirFilter, sessions])

    useEffect(() => {
        setPageIndex((current) => Math.min(current, totalPages - 1))
    }, [totalPages])

    const toggleSession = (sessionId: string) => {
        if (isPending || isLoading) return
        setSelectedSessionIds((current) => current.includes(sessionId)
            ? current.filter((id) => id !== sessionId)
            : [...current, sessionId])
    }

    const selectAll = () => {
        setSelectedSessionIds(filteredSessions.map((session) => session.id))
    }

    const clearAll = () => {
        setSelectedSessionIds([])
    }

    const handleConfirm = async () => {
        if (selectedSessionIds.length === 0 || isPending || isLoading) return
        await onConfirm(selectedSessionIds)
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader className="text-left">
                    <DialogTitle>{t('runnerImport.dialog.title')}</DialogTitle>
                    <DialogDescription>
                        {t('runnerImport.dialog.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 space-y-3">
                    <label className="block min-w-0 text-xs text-[var(--app-hint)]">
                        <span className="mb-1 block">{t('runnerImport.dialog.runner')}</span>
                        <select
                            className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                            value={selectedMachineId ?? ''}
                            disabled={isPending || isLoading || machines.length === 0}
                            onChange={(event) => onMachineChange(event.target.value)}
                        >
                            {machines.length === 0 ? (
                                <option value="">{t('runnerImport.runners.emptyShort')}</option>
                            ) : null}
                            {machines.map((machine) => (
                                <option key={machine.id} value={machine.id}>
                                    {getMachineTitle(machine)}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="block min-w-0 text-xs text-[var(--app-hint)]">
                        <span className="mb-1 block">{t('runnerImport.dialog.agent')}</span>
                        <select
                            className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                            value={selectedFlavor}
                            disabled={isPending || isLoading}
                            onChange={(event) => onFlavorChange(event.target.value as RunnerImportFlavor)}
                        >
                            <option value="claude">Claude Code</option>
                            <option value="codex">Codex</option>
                            <option value="opencode">OpenCode</option>
                        </select>
                    </label>

                    <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('runnerImport.dialog.selectedCount', { n: selectedSessionIds.length })}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={onReload}
                                disabled={isPending || isLoading || isRefreshing || !selectedMachineId}
                            >
                                {t('runnerImport.dialog.refresh')}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={clearAll}
                                disabled={isPending || isLoading || selectedSessionIds.length === 0}
                            >
                                {t('runnerImport.dialog.clear')}
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={selectAll}
                                disabled={isPending || isLoading || filteredSessions.length === 0}
                            >
                                {t('runnerImport.dialog.selectAll')}
                            </Button>
                        </div>
                    </div>

                    {isRefreshing ? (
                        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                            {t('runnerImport.dialog.refreshing')}
                        </div>
                    ) : null}

                    {refreshError ? (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
                            {t('runnerImport.dialog.refreshFailed', { error: refreshError })}
                        </div>
                    ) : null}

                    {sessions.length > 0 ? (
                        <label className="block min-w-0 text-xs text-[var(--app-hint)]">
                            <span className="mb-1 block">{t('runnerImport.dialog.workdir')}</span>
                            <select
                                className="h-8 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                value={workdirFilter}
                                disabled={isPending || isLoading || workdirOptions.length === 0}
                                onChange={(event) => setWorkdirFilter(event.target.value)}
                            >
                                <option value={ALL_WORKDIR_FILTER}>{t('runnerImport.dialog.allDirectories')}</option>
                                {workdirOptions.map((directory) => (
                                    <option key={directory} value={directory}>{directory}</option>
                                ))}
                            </select>
                        </label>
                    ) : null}

                    {filteredSessions.length > SESSION_LIST_PAGE_SIZE ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                            <div>
                                {t('runnerImport.dialog.pageStatus', {
                                    page: pageIndex + 1,
                                    pages: totalPages,
                                    total: filteredSessions.length
                                })}
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                                    disabled={isPending || isLoading || pageIndex === 0}
                                >
                                    {t('runnerImport.dialog.previousPage')}
                                </Button>
                                <label className="flex items-center gap-1">
                                    <span>{t('runnerImport.dialog.pageInput')}</span>
                                    <input
                                        type="number"
                                        min={1}
                                        max={totalPages}
                                        value={pageIndex + 1}
                                        disabled={isPending || isLoading}
                                        onChange={(event) => {
                                            const next = Number.parseInt(event.target.value, 10)
                                            if (!Number.isFinite(next)) return
                                            setPageIndex(Math.min(totalPages - 1, Math.max(0, next - 1)))
                                        }}
                                        className="h-7 w-16 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                    />
                                </label>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setPageIndex((current) => Math.min(totalPages - 1, current + 1))}
                                    disabled={isPending || isLoading || pageIndex >= totalPages - 1}
                                >
                                    {t('runnerImport.dialog.nextPage')}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {failedImportResults.length > 0 ? (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
                            <div className="font-medium">{t('runnerImport.dialog.failuresTitle')}</div>
                            {failedImportResults.slice(0, 5).map((failure) => (
                                <div key={failure.agentSessionId} className="mt-1 break-words">
                                    <span className="font-mono">{failure.agentSessionId}</span>: {failure.error}
                                </div>
                            ))}
                            {failedImportResults.length > 5 ? (
                                <div className="mt-1">{t('runnerImport.dialog.failuresMore', { n: failedImportResults.length - 5 })}</div>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]">
                        {isLoading ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('runnerImport.dialog.loading')}
                            </div>
                        ) : isRefreshing && sessions.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('runnerImport.dialog.refreshing')}
                            </div>
                        ) : sessions.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('runnerImport.dialog.empty', { agent: getFlavorLabel(selectedFlavor) })}
                            </div>
                        ) : filteredSessions.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                                {t('runnerImport.dialog.emptyForWorkdir')}
                            </div>
                        ) : (
                            <div className="divide-y divide-[var(--app-border)]">
                                {pageSessions.map((session) => {
                                    const checked = selectedSessionIdSet.has(session.id)
                                    const cwd = getSessionCwd(session)
                                    const time = formatTime(session.modifiedAt)
                                    return (
                                        <label
                                            key={session.id}
                                            className="flex cursor-pointer items-start gap-3 px-3 py-2 transition-colors hover:bg-[var(--app-subtle-bg)]"
                                        >
                                            <input
                                                type="checkbox"
                                                className="mt-1 h-4 w-4 accent-[var(--app-link)]"
                                                checked={checked}
                                                disabled={isPending || isLoading}
                                                onChange={() => toggleSession(session.id)}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                                                        {session.title}
                                                    </div>
                                                    <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                        {t('runnerImport.dialog.messageCount', { n: session.messageCount ?? 0 })}
                                                    </span>
                                                </div>
                                                {session.lastUserMessage ? (
                                                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">
                                                        {session.lastUserMessage}
                                                    </div>
                                                ) : null}
                                                {failureBySessionId.get(session.id) ? (
                                                    <div className="mt-0.5 break-words text-xs text-red-600">
                                                        {failureBySessionId.get(session.id)}
                                                    </div>
                                                ) : null}
                                                {cwd ? (
                                                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-[var(--app-hint)]">
                                                        <span className="shrink-0">{t('runnerImport.dialog.cwd')}</span>
                                                        <span className="min-w-0 truncate font-mono" title={cwd}>{cwd}</span>
                                                    </div>
                                                ) : null}
                                                {time ? (
                                                    <div className="mt-0.5 text-[11px] text-[var(--app-hint)]">
                                                        {time}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </label>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('runnerImport.dialog.cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleConfirm()}
                        disabled={isPending || isLoading || selectedSessionIds.length === 0}
                    >
                        {isPending ? t('runnerImport.dialog.confirming') : t('runnerImport.dialog.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
