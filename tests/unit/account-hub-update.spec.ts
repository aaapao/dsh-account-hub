import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import {
  appendAccountHubAllowBuild,
  applyAccountHubUpdate,
  checkAccountHubUpdate,
  extractAccountHubSha,
  lastAccountHubApplyResult,
  removeStaleAllowBuildEntries,
  resetAccountHubUpdateState,
  type AccountHubUpdateDeps,
  type AccountHubUpdateExec,
} from '../../src/account-hub-update.js'

const PROFILE_ROOT = 'C:\\fake-profile'
const CURRENT_SHA = 'a'.repeat(40)
const LATEST_SHA = 'b'.repeat(40)
const LATEST_TAG = 'v0.2.0'
const RELEASES_LATEST_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest'
const COMMIT_BY_REF_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/'
const COMMIT_COMPARE_URL_PREFIX = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/compare/'
const COMMITS_URL = 'https://api.github.com/repos/gurio-wine/dsh-account-hub/commits'
const ACCOUNT_HUB_PIN = 'github:gurio-wine/dsh-account-hub'
const LOCK_PATH = join(PROFILE_ROOT, 'pnpm-lock.yaml')
const PACKAGE_PATH = join(PROFILE_ROOT, 'package.json')
const WORKSPACE_PATH = join(PROFILE_ROOT, 'pnpm-workspace.yaml')

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeLockfile(sha: string): string {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      dsh-account-hub:',
    '        specifier: https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/' + sha,
    '        version: https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/' + sha,
    'packages:',
    '',
  ].join('\n')
}

function makeLockfileWithoutAccountHub(): string {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      other-package:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    'packages:',
    '',
  ].join('\n')
}

function makePackageJson(pin = ACCOUNT_HUB_PIN): string {
  return [
    '{',
    '  "name": "fake-profile",',
    '  "dependencies": {',
    `    "dsh-account-hub": "${pin}",`,
    '    "other-package": "1.0.0"',
    '  },',
    '  "scripts": {',
    '    "start": "dsh"',
    '  }',
    '}',
    '',
  ].join('\n')
}

function makeReleaseResponse(
  tag: string,
  name: string | undefined,
  body: string | undefined,
  status = 200,
): Response {
  const responseBody: { tag_name: string; name?: string; body?: string } = { tag_name: tag }
  if (name !== undefined) responseBody.name = name
  if (body !== undefined) responseBody.body = body
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCommitResponse(sha: string, message = '提交说明'): Response {
  return new Response(JSON.stringify({ sha, commit: { message } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCommitListResponse(messages: string[]): Response {
  return new Response(JSON.stringify(messages.map((message) => ({ commit: { message } }))), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCompareResponse(messages: string[]): Response {
  return new Response(JSON.stringify({ commits: messages.map((message) => ({ commit: { message } })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeDeps(options: {
  lockfile?: string
  packageJson?: string
  workspace?: string
  latestSha?: string
  latestTagSha?: string
  headSha?: string
  currentSha?: string
  latestTag?: string
  releaseName?: string
  omitReleaseName?: boolean
  releaseBody?: string
  omitReleaseBody?: boolean
  headMessage?: string
  currentCommitMessage?: string
  compareMessages?: string[]
  currentCompareMessages?: string[]
  recentMessages?: string[]
  releaseStatus?: number
  exec?: AccountHubUpdateExec
  outputChunks?: {
    remove?: string[]
    add?: string[]
  }
} = {}): {
  deps: AccountHubUpdateDeps
  files: Map<string, string>
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>
  exec: ReturnType<typeof vi.fn<AccountHubUpdateExec>>
} {
  const latestSha = options.latestSha ?? LATEST_SHA
  const latestTagSha = options.latestTagSha ?? latestSha
  const headSha = options.headSha ?? latestSha
  const currentSha = options.currentSha ?? CURRENT_SHA
  const latestTag = options.latestTag ?? LATEST_TAG
  const releaseName = options.omitReleaseName ? undefined : options.releaseName ?? '更新标题'
  const releaseBody = options.omitReleaseBody ? undefined : options.releaseBody ?? '稳定版本更新日志'
  const headMessage = options.headMessage ?? 'Beta 提交标题\n更多提交说明'
  const compareMessages = options.compareMessages ?? ['Beta 改动\n提交正文']
  const currentCompareMessages = options.currentCompareMessages ?? ['当前领先提交\n提交正文']
  const currentCommitMessage = options.currentCommitMessage ?? currentCompareMessages[0] ?? ''
  const recentMessages = options.recentMessages ?? ['master HEAD 提交\n提交正文']
  const files = new Map<string, string>([
    [LOCK_PATH, options.lockfile ?? makeLockfile(currentSha)],
    [LOCK_PATH, options.lockfile ?? makeLockfile(CURRENT_SHA)],
    [PACKAGE_PATH, options.packageJson ?? makePackageJson()],
    [WORKSPACE_PATH, options.workspace ?? 'allowBuilds:\n  esbuild: true\n'],
  ])
  const readFile = vi.fn(async (path: string) => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  const writeFile = vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  })
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === RELEASES_LATEST_URL) {
      return makeReleaseResponse(latestTag, releaseName, releaseBody, options.releaseStatus ?? 200)
    }
    if (url === `${COMMIT_BY_REF_URL_PREFIX}${encodeURIComponent(latestTag)}`) {
      return makeCommitResponse(latestTagSha, 'Release tag commit')
    }
    if (url === `${COMMIT_BY_REF_URL_PREFIX}master`) return makeCommitResponse(headSha, headMessage)
    if (url.startsWith(COMMIT_BY_REF_URL_PREFIX)) {
      const ref = decodeURIComponent(url.slice(COMMIT_BY_REF_URL_PREFIX.length))
      if (ref === currentSha) return makeCommitResponse(currentSha, currentCommitMessage)
      return makeCommitResponse(ref, '提交说明')
    }
    if (url === `${COMMITS_URL}?per_page=20`) return makeCommitListResponse(recentMessages)
    if (url.startsWith(COMMIT_COMPARE_URL_PREFIX)) {
      const comparison = url.slice(COMMIT_COMPARE_URL_PREFIX.length).split('?', 1)[0]
      return comparison === `${latestTagSha}...${currentSha}`
        ? makeCompareResponse(currentCompareMessages)
        : makeCompareResponse(compareMessages)
    }
    throw new Error(`Unexpected GitHub API URL: ${url}`)
  })
  const defaultExec: AccountHubUpdateExec = async (_command, args, execOptions) => {
    const outputChunks = args[0] === 'remove'
      ? options.outputChunks?.remove ?? []
      : options.outputChunks?.add ?? []
    for (const chunk of outputChunks) execOptions.onOutput?.(chunk)
    if (args[0] === 'add') {
      const pin = String(args[1])
      const addedSha = pin.split('#').at(-1) ?? latestSha
      files.set(LOCK_PATH, makeLockfile(addedSha))
      files.set(PACKAGE_PATH, makePackageJson(pin))
    }
    return args[0] === 'remove'
      ? { stdout: '卸载完成\n', stderr: '' }
      : { stdout: '安装完成\n', stderr: '' }
  }
  const exec = vi.fn<AccountHubUpdateExec>(options.exec ?? defaultExec)
  return {
    deps: { profileRoot: PROFILE_ROOT, readFile, writeFile, fetcher, exec },
    files,
    fetcher,
    exec,
  }
}

/**
 * 构造一个在首次 add 阶段挂起的依赖：用于验证模块级互斥，而不是依赖
 * 定时器或真实子进程。首次 add 放行后，后续调用会正常完成，便于同时验证
 * finally 确实释放锁。
 */
function makePausedApplyDeps() {
  const addStarted = deferred<void>()
  const addGate = deferred<void>()
  let files: Map<string, string> | undefined
  let addCallCount = 0
  const prepared = makeDeps({
    packageJson: '{\n  "name": "fake-profile",\n  "private": true\n}\n',
    exec: async (_command, args) => {
      if (args[0] !== 'add') return { stdout: '卸载完成\\n', stderr: '' }

      addCallCount += 1
      if (addCallCount === 1) {
        addStarted.resolve(undefined)
        await addGate.promise
      }
      const pin = String(args[1])
      const addedSha = pin.split('#').at(-1) ?? LATEST_SHA
      files?.set(LOCK_PATH, makeLockfile(addedSha))
      files?.set(PACKAGE_PATH, makePackageJson(pin))
      return { stdout: '安装完成\\n', stderr: '' }
    },
  })
  files = prepared.files
  return {
    ...prepared,
    addStarted: addStarted.promise,
    releaseAdd: () => addGate.resolve(undefined),
  }
}

function makeUpdateRpcCaller(deps: AccountHubUpdateDeps) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const ctx: Record<string, unknown> = {}
  ctx.connection = {
    fetch: {
      register: (options: { fetch: (request: Request) => Promise<Response> }) => {
        handler = options.fetch
      },
    },
  }
  ctx.inject = (_deps: string[], callback: (ctx: unknown) => void) => callback(ctx)
  ctx.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  ctx.get = () => undefined

  registerAccountHubRpc({
    ctx: ctx as never,
    pool: {} as never,
    codearts: {} as never,
    buddyCn: {} as never,
    buddy: {} as never,
    lobsterai: {} as never,
    traeCn: {} as never,
    qoder: {} as never,
    qoderCn: {} as never,
    updateDeps: deps,
  })
  if (handler === undefined) throw new Error('update RPC handler was not registered')

  return async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'update-rpc-1',
        method: 'account-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: Record<string, unknown>; error?: { message: string } }
    }
    return body.result
  }
}

describe('Account Hub 更新 RPC 逻辑', () => {
  // 模块级互斥/进度/最近结果是跨用例的共享状态：每条用例结束都复位，
  // 防止上一条把锁或 applied 残留漏给下一条（并发用例尤其会污染）。
  afterEach(() => { resetAccountHubUpdateState() })

  it('从 dependencies 中 dsh-account-hub 的 tarball URL 提取完整 SHA 并返回客户端字段', async () => {
    const { deps, fetcher } = makeDeps()
    const result = await checkAccountHubUpdate(deps)

    expect(extractAccountHubSha(makeLockfile(CURRENT_SHA))).toBe(CURRENT_SHA)
    expect(result).toEqual({
      currentSha: CURRENT_SHA,
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: '更新标题',
      currentVersion: CURRENT_SHA.slice(0, 8),
      latestVersion: LATEST_TAG,
      changelog: '稳定版本更新日志',
      currentChangelog: '',
    })
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/gurio-wine/dsh-account-hub/releases/latest',
      expect.objectContaining({ headers: { accept: 'application/vnd.github+json' } }),
    )
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/gurio-wine/dsh-account-hub/commits/${LATEST_TAG}`,
      expect.objectContaining({ headers: { accept: 'application/vnd.github+json' } }),
    )
  })

  it('stable 无更新时显示 release tag 并复用 release body 作为当前与最新日志', async () => {
    const { deps } = makeDeps({
      lockfile: makeLockfile(LATEST_SHA),
      currentSha: LATEST_SHA,
      releaseBody: 'Release v0.2.0\n\n- 正式版本内容',
    })

    await expect(checkAccountHubUpdate(deps, 'stable')).resolves.toMatchObject({
      currentSha: LATEST_SHA,
      latestSha: LATEST_SHA,
      hasUpdate: false,
      currentVersion: LATEST_TAG,
      latestVersion: LATEST_TAG,
      changelog: 'Release v0.2.0\n\n- 正式版本内容',
      currentChangelog: 'Release v0.2.0\n\n- 正式版本内容',
    })
  })

  it('无 GitHub release 时给出清晰提示并停止第二跳', async () => {
    const { deps, fetcher } = makeDeps({ releaseStatus: 404 })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow(
      '尚无 GitHub release，无法检查更新（发首个 release 后可检查）',
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('release 没有 name/body 时 title 回退 tag 且 changelog 为空', async () => {
    const { deps } = makeDeps({ omitReleaseName: true, omitReleaseBody: true })

    await expect(checkAccountHubUpdate(deps)).resolves.toMatchObject({
      latestTag: LATEST_TAG,
      latestTitle: LATEST_TAG,
      changelog: '',
      currentChangelog: '',
    })
  })

  it('beta 有更新时使用 master HEAD 并以 compare 提交标题生成 changelog', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
      compareMessages: ['新增功能\n详细说明', '修复问题\n详细说明'],
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      currentSha: CURRENT_SHA,
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: 'Beta 提交标题',
      currentVersion: `${LATEST_TAG}+${CURRENT_SHA.slice(0, 7)}`,
      latestVersion: `${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`,
      changelog: '- 新增功能\n- 修复问题',
      currentChangelog: '- 当前领先提交',
    })
    expect(fetcher).toHaveBeenCalledWith(
      `${COMMIT_COMPARE_URL_PREFIX}${CURRENT_SHA}...master?per_page=20`,
      expect.any(Object),
    )
  })

  it('beta 无更新时 currentChangelog 包含当前 commit 提交信息', async () => {
    const { deps } = makeDeps({
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      latestTagSha: CURRENT_SHA,
      headSha: CURRENT_SHA,
      currentCommitMessage: '当前 beta 提交信息\n提交正文',
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      hasUpdate: false,
      currentChangelog: '- 当前 beta 提交信息',
    })
  })

  it('beta currentSha 为空时从最近 20 条 commits 生成 changelog', async () => {
    const recentMessages = Array.from({ length: 22 }, (_, index) => `提交 ${index + 1}\n详细说明`)
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfileWithoutAccountHub(),
      currentSha: '',
      headSha: LATEST_SHA,
      recentMessages,
    })

    const result = await checkAccountHubUpdate(deps, 'beta')

    expect(result.currentVersion).toBe('')
    expect(result.latestVersion).toBe(`${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`)
    expect(result.changelog.split('\n')).toHaveLength(20)
    expect(result.changelog).toContain('- 提交 1')
    expect(result.changelog).toContain('- 提交 20')
    expect(result.changelog).not.toContain('提交 21')
    expect(result.currentChangelog).toBe('')
    expect(fetcher).toHaveBeenCalledWith(`${COMMITS_URL}?per_page=20`, expect.any(Object))
  })

  it('beta currentChangelog 仅列出 release tag 之后的当前版本提交', async () => {
    const { deps } = makeDeps({
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      latestTagSha: LATEST_SHA,
      headSha: LATEST_SHA,
      currentCompareMessages: ['当前领先提交\n提交正文'],
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      currentChangelog: '- 当前领先提交',
    })
  })

  it('beta 在没有 release 时以 beta 作为 tag 前缀继续检查 master', async () => {
    const { deps } = makeDeps({
      releaseStatus: 404,
      lockfile: makeLockfile(CURRENT_SHA),
      currentSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })

    await expect(checkAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      latestTag: 'beta',
      latestVersion: `beta+${LATEST_SHA.slice(0, 7)}`,
      hasUpdate: true,
    })
  })

  it('lockfile 没有目标依赖时报告半卸载状态并提示有更新', async () => {
    const lockfile = makeLockfileWithoutAccountHub()
    const { deps } = makeDeps({ lockfile })

    await expect(checkAccountHubUpdate(deps)).resolves.toEqual({
      currentSha: '',
      latestSha: LATEST_SHA,
      latestTag: LATEST_TAG,
      hasUpdate: true,
      latestTitle: '更新标题',
      currentVersion: '',
      latestVersion: LATEST_TAG,
      changelog: '稳定版本更新日志',
      currentChangelog: '',
    })
    expect(() => extractAccountHubSha(lockfile)).toThrow(
      'pnpm-lock.yaml dependencies 段中找不到 dsh-account-hub',
    )
  })

  it('lockfile 中目标依赖的 tarball SHA 畸形时拒绝检查', async () => {
    const { deps, fetcher } = makeDeps({
      lockfile: makeLockfile('f'.repeat(39)),
    })

    await expect(checkAccountHubUpdate(deps)).rejects.toThrow('无法提取 40 位 SHA')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allowBuilds 追加 tarball 条目且重复调用幂等', () => {
    const workspace = 'allowBuilds:\n  esbuild: true\n'
    const once = appendAccountHubAllowBuild(workspace, LATEST_SHA)
    const twice = appendAccountHubAllowBuild(once, LATEST_SHA)
    const key = `dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`

    expect(once).toContain(`  ${key}`)
    expect(twice).toBe(once)
    expect(once.split(key)).toHaveLength(2)
  })

  it('allowBuilds 清理旧 tarball 条目并保留当前 SHA 与空段头', () => {
    const staleSha = 'c'.repeat(40)
    const workspace = [
      'allowBuilds:',
      `  dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${staleSha}: true`,
      `  dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true # keep`,
      '  esbuild: true',
      '',
    ].join('\n')

    const cleaned = removeStaleAllowBuildEntries(workspace, LATEST_SHA)

    expect(cleaned).not.toContain(staleSha)
    expect(cleaned).toContain(`${LATEST_SHA}: true # keep`)
    expect(cleaned).toContain('  esbuild: true')

    const empty = removeStaleAllowBuildEntries(
      `allowBuilds:\n  dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${staleSha}: true\n`,
      LATEST_SHA,
    )
    expect(empty).toBe('allowBuilds:\n')
  })
  it('apply 在成功安装后确认 lockfile 已切换，并返回完整安装日志', async () => {
    const { deps, files, exec, fetcher } = makeDeps()
    const result = await applyAccountHubUpdate(deps)

    expect(result).toEqual({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
      log: 'stdout:\n卸载完成\n\nstdout:\n安装完成\n',
    })
    expect(files.get(WORKSPACE_PATH)).toContain(`dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`)
    expect(deps.writeFile).toHaveBeenCalledTimes(1)
    expect(deps.writeFile).toHaveBeenCalledWith(
      WORKSPACE_PATH,
      expect.stringContaining(`dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`),
    )
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['remove', 'dsh-account-hub'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('apply 成功后清理旧 allowBuilds 条目并保留新 SHA', async () => {
    const staleSha = 'c'.repeat(40)
    const workspace = [
      'allowBuilds:',
      `  dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${staleSha}: true`,
      '  esbuild: true',
      '',
    ].join('\n')
    const { deps, files } = makeDeps({ workspace })

    await applyAccountHubUpdate(deps)

    const cleaned = files.get(WORKSPACE_PATH) ?? ''
    expect(cleaned).not.toContain(staleSha)
    expect(cleaned).toContain(`${LATEST_SHA}: true`)
    expect(cleaned).toContain('allowBuilds:')
  })
  it('allowBuilds 清理失败不影响成功安装返回', async () => {
    const { deps } = makeDeps()
    const originalReadFile = deps.readFile
    let workspaceReads = 0
    deps.readFile = async (path) => {
      if (path === WORKSPACE_PATH) {
        workspaceReads += 1
        if (workspaceReads === 2) throw new Error('workspace cleanup failed')
      }
      return originalReadFile(path)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
        previousSha: CURRENT_SHA,
        currentSha: LATEST_SHA,
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('清理旧 allowBuilds 条目失败'))
    } finally {
      warn.mockRestore()
    }
  })

  it('apply 传入 targetSha 时跳过 latest fetch 并安装指定 SHA', async () => {
    const targetSha = 'c'.repeat(40)
    const { deps, files, exec, fetcher } = makeDeps()

    await expect(applyAccountHubUpdate(deps, 'stable', undefined, targetSha)).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: targetSha,
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${targetSha}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(files.get(PACKAGE_PATH)).toContain(targetSha)
  })

  it('apply 传入非法 targetSha 时在任何 fetch 或安装前失败', async () => {
    const { deps, exec, fetcher } = makeDeps()

    await expect(applyAccountHubUpdate(deps, 'stable', undefined, 'not-a-sha')).rejects.toThrow(
      'targetSha 不是有效的 40 位 SHA',
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })
  it('apply 按 removing、installing、verifying 顺序上报阶段，并在无依赖时跳过 removing', async () => {
    const progress: Array<[string, string]> = []
    const { deps } = makeDeps()
    await applyAccountHubUpdate(deps, 'stable', (phase, detail) => {
      progress.push([phase, detail])
    })
    expect(progress).toEqual([
      ['removing', '正在卸载旧版本…'],
      ['installing', '正在安装新版本…'],
      ['verifying', '正在验证安装…'],
    ])

    const noDependencyProgress: Array<[string, string]> = []
    const noDependency = makeDeps({
      packageJson: '{\n  "name": "fake-profile",\n  "private": true\n}\n',
    })
    await applyAccountHubUpdate(noDependency.deps, 'stable', (phase, detail) => {
      noDependencyProgress.push([phase, detail])
    })
    expect(noDependencyProgress).toEqual([
      ['installing', '正在安装新版本…'],
      ['verifying', '正在验证安装…'],
    ])
  })

  it('apply 将 pnpm 输出清洗截断后按阶段实时上报', async () => {
    const progress: Array<[string, string]> = []
    const longLine = 'x'.repeat(121)
    const { deps } = makeDeps({
      outputChunks: {
        remove: ['\x1b[31m正在卸载依赖\x1b[0m\n\n', '卸载完成\n'],
        add: [`\x1b[32m${longLine}\x1b[0m\n`, '\n安装收尾\n'],
      },
    })

    await applyAccountHubUpdate(deps, 'stable', (phase, detail) => {
      progress.push([phase, detail])
    })

    expect(progress).toEqual([
      ['removing', '正在卸载旧版本…'],
      ['removing', '正在卸载依赖'],
      ['removing', '卸载完成'],
      ['installing', '正在安装新版本…'],
      ['installing', `${longLine.slice(0, 120)}…`],
      ['installing', '安装收尾'],
      ['verifying', '正在验证安装…'],
    ])
    expect(progress.filter(([phase]) => phase === 'removing')).toHaveLength(3)
    expect(progress.filter(([phase]) => phase === 'installing')).toHaveLength(3)
  })
  it('apply beta 通道按 master HEAD SHA 安装', async () => {
    const { deps, exec } = makeDeps({
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })

    await expect(applyAccountHubUpdate(deps, 'beta')).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('package.json 缺少依赖字段时跳过 remove 直接 add', async () => {
    const { deps, exec } = makeDeps({ packageJson: '{\n  "name": "fake-profile",\n  "private": true\n}\n' })

    await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith(
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('lockfile 没有依赖条目时 previousSha 为空并仍完成安装', async () => {
    const { deps, exec } = makeDeps({ lockfile: makeLockfileWithoutAccountHub() })

    await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
      previousSha: '',
      currentSha: LATEST_SHA,
    })
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      ['remove', 'dsh-account-hub'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      { cwd: PROFILE_ROOT, timeoutMs: 120_000 },
    )
  })

  it('apply 已是最新版本时不改 workspace、不启动 pnpm', async () => {
    const { deps, files, exec } = makeDeps({ latestSha: CURRENT_SHA })
    const workspaceBefore = files.get(WORKSPACE_PATH)

    await expect(applyAccountHubUpdate(deps)).resolves.toEqual({
      previousSha: CURRENT_SHA,
      currentSha: CURRENT_SHA,
      log: '',
    })
    expect(files.get(WORKSPACE_PATH)).toBe(workspaceBefore)
    expect(exec).not.toHaveBeenCalled()
  })

  it('remove 失败时不改 workspace 且不启动 add', async () => {
    const failure = Object.assign(new Error('pnpm remove failed'), {
      code: 1,
      stdout: 'remove stdout',
      stderr: 'remove stderr',
    })
    const { deps, files, exec } = makeDeps({ exec: async () => { throw failure } })
    const packageBefore = files.get(PACKAGE_PATH)
    const workspaceBefore = files.get(WORKSPACE_PATH)

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm remove failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr',
    )
    expect(files.get(PACKAGE_PATH)).toBe(packageBefore)
    expect(files.get(WORKSPACE_PATH)).toBe(workspaceBefore)
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('add 失败时保留原始错误并附 remove 与 add 日志', async () => {
    const failure = Object.assign(new Error('pnpm add failed'), {
      code: 1,
      stdout: 'add stdout',
      stderr: 'add stderr',
    })
    const { deps, exec } = makeDeps({
      exec: async (_command, args) => {
        if (args[0] === 'remove') return { stdout: 'remove stdout', stderr: 'remove stderr' }
        throw failure
      },
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm add failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr\nstdout:\nadd stdout\nstderr:\nadd stderr',
    )
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('apply 进行中拒绝第二笔 apply，并在首笔完成后释放锁', async () => {
    const paused = makePausedApplyDeps()
    // 模块级互斥保护 remove→add 期间的半套磁盘状态；首次 add 挂起时第二笔必须立即让路。
    const first = applyAccountHubUpdate(paused.deps)
    await paused.addStarted

    try {
      await expect(applyAccountHubUpdate(paused.deps)).rejects.toThrow('更新进行中')
    } finally {
      // 用例必须等首笔 promise settle，避免模块级锁残留污染后续用例。
      paused.releaseAdd()
      await expect(first).resolves.toMatchObject({
        previousSha: CURRENT_SHA,
        currentSha: LATEST_SHA,
      })
    }

    // 首笔 finally 已释放模块级锁；第二次调用不应再得到互斥错误。
    await expect(applyAccountHubUpdate(paused.deps)).resolves.toMatchObject({
      previousSha: LATEST_SHA,
      currentSha: LATEST_SHA,
    })
  })

  it('apply 进行中拒绝 check，首笔完成后仍能正常收尾', async () => {
    const paused = makePausedApplyDeps()
    // check 与 apply 共享模块级互斥，避免 check 读到 remove/add 之间的半套文件。
    const first = applyAccountHubUpdate(paused.deps)
    await paused.addStarted

    try {
      await expect(checkAccountHubUpdate(paused.deps)).rejects.toThrow('更新进行中')
    } finally {
      // 无论断言是否成功都释放受控 add，并等待 apply 的 finally 执行。
      paused.releaseAdd()
      await expect(first).resolves.toMatchObject({
        previousSha: CURRENT_SHA,
        currentSha: LATEST_SHA,
      })
    }
  })

  it('apply 失败后释放锁，并保存失败结果快照', async () => {
    const failure = Object.assign(new Error('受控安装失败'), {
      code: 1,
      stdout: 'add stdout',
      stderr: 'add stderr',
    })
    const { deps, exec } = makeDeps({ exec: async () => { throw failure } })
    // 失败路径也必须执行模块级互斥的 finally，否则后续更新会永久收到“更新进行中”。
    await expect(applyAccountHubUpdate(deps)).rejects.toThrow('受控安装失败')
    await expect(applyAccountHubUpdate(deps)).rejects.toThrow('受控安装失败')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(lastAccountHubApplyResult()).toMatchObject({
      ok: false,
      previousSha: '',
      currentSha: '',
      error: expect.stringContaining('受控安装失败'),
    })
    expect(lastAccountHubApplyResult()?.error).not.toContain('更新进行中')
  })

  it('apply 成功后保存成功结果快照', async () => {
    const { deps } = makeDeps()
    // 成功路径同样写入模块级最近结果，供更新状态在 apply 返回后继续读取。
    await expect(applyAccountHubUpdate(deps)).resolves.toMatchObject({
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
    expect(lastAccountHubApplyResult()).toEqual({
      ok: true,
      previousSha: CURRENT_SHA,
      currentSha: LATEST_SHA,
    })
  })

  it('update RPC 将 beta 透传给 check/apply，缺省和非法 channel 回退 stable', async () => {
    const { deps, exec } = makeDeps({
      latestTagSha: CURRENT_SHA,
      headSha: LATEST_SHA,
    })
    const call = makeUpdateRpcCaller(deps)

    const betaCheck = await call('update.check', { channel: 'beta' })
    expect(betaCheck.ok).toBe(true)
    expect(betaCheck.value).toMatchObject({
      latestSha: LATEST_SHA,
      latestVersion: `${LATEST_TAG}+${LATEST_SHA.slice(0, 7)}`,
    })

    const defaultCheck = await call('update.check', {})
    expect(defaultCheck.value).toMatchObject({
      latestSha: CURRENT_SHA,
      latestVersion: LATEST_TAG,
      hasUpdate: false,
    })

    const invalidCheck = await call('update.check', { channel: 'nightly' })
    expect(invalidCheck.value).toMatchObject({
      latestSha: CURRENT_SHA,
      latestVersion: LATEST_TAG,
      hasUpdate: false,
    })

    const initialStatus = await call('update.status', {})
    expect(initialStatus).toEqual({ ok: true, value: { phase: 'idle', detail: '', result: null } })

    const betaApply = await call('update.apply', { channel: 'beta' })
    expect(betaApply.ok).toBe(true)
    expect(betaApply.value).toMatchObject({ currentSha: LATEST_SHA })
    const finalStatus = await call('update.status', {})
    expect(finalStatus).toEqual({ ok: true, value: { phase: 'applied', detail: '安装完成', result: { ok: true, previousSha: CURRENT_SHA, currentSha: LATEST_SHA } } })
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${LATEST_SHA}`, '--config.minimum-release-age=0'],
      expect.objectContaining({ cwd: PROFILE_ROOT, timeoutMs: 120_000 }),
    )
  })

  it('update.apply RPC 透传 targetSha 并拒绝非法 targetSha', async () => {
    const targetSha = 'c'.repeat(40)
    const { deps, exec, fetcher } = makeDeps()
    const call = makeUpdateRpcCaller(deps)

    const result = await call('update.apply', { targetSha })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ currentSha: targetSha })
    expect(fetcher).not.toHaveBeenCalled()
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      ['add', `${ACCOUNT_HUB_PIN}#${targetSha}`, '--config.minimum-release-age=0'],
      expect.objectContaining({ cwd: PROFILE_ROOT, timeoutMs: 120_000 }),
    )

    const invalid = await call('update.apply', { targetSha: 'invalid' })
    expect(invalid.ok).toBe(false)
    expect(invalid.error?.message).toContain('targetSha 不是有效的 40 位 SHA')
  })
  it('pnpm 成功但 lockfile SHA 未变化时失败并附完整日志', async () => {
    const { deps } = makeDeps({
      exec: async () => ({ stdout: 'pnpm stdout', stderr: 'pnpm stderr' }),
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      `更新后 lockfile 未切换到最新版本（期望 ${LATEST_SHA}，实际 ${CURRENT_SHA}）\n\nstdout:\npnpm stdout\nstderr:\npnpm stderr\nstdout:\npnpm stdout\nstderr:\npnpm stderr`,
    )
  })

  it('pnpm 超时时保留超时信息与已捕获的完整日志', async () => {
    const timeout = Object.assign(new Error('Command timed out'), {
      code: 'ETIMEDOUT',
      stdout: 'timeout stdout',
      stderr: 'timeout stderr',
    })
    const { deps } = makeDeps({ exec: async () => { throw timeout } })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'Command timed out (code ETIMEDOUT)\n\nstdout:\ntimeout stdout\nstderr:\ntimeout stderr',
    )
  })

  it('add 失败且中途改写三个文件时恢复全部快照并保留原安装错误与日志', async () => {
    const failure = Object.assign(new Error('pnpm add failed'), {
      code: 1,
      stdout: 'add stdout',
      stderr: 'add stderr',
    })
    const initialLockfile = makeLockfile(CURRENT_SHA)
    const initialPackageJson = makePackageJson()
    const initialWorkspace = 'allowBuilds:\n  esbuild: true\n'
    const { deps, files, exec } = makeDeps({
      lockfile: initialLockfile,
      packageJson: initialPackageJson,
      workspace: initialWorkspace,
      exec: async (_command, args) => {
        if (args[0] === 'remove') {
          files.set(PACKAGE_PATH, '{"name":"changed-by-remove"}\n')
          return { stdout: 'remove stdout', stderr: 'remove stderr' }
        }
        files.set(LOCK_PATH, makeLockfile(LATEST_SHA))
        files.set(PACKAGE_PATH, makePackageJson(`${ACCOUNT_HUB_PIN}#${LATEST_SHA}`))
        files.set(WORKSPACE_PATH, 'allowBuilds:\n  changed: true\n')
        throw failure
      },
    })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
      'pnpm add failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr\nstdout:\nadd stdout\nstderr:\nadd stderr',
    )
    expect(files.get(LOCK_PATH)).toBe(initialLockfile)
    expect(files.get(PACKAGE_PATH)).toBe(initialPackageJson)
    expect(files.get(WORKSPACE_PATH)).toBe(initialWorkspace)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('remove 失败时不发生任何快照回写', async () => {
    const failure = Object.assign(new Error('pnpm remove failed'), {
      code: 1,
      stdout: 'remove stdout',
      stderr: 'remove stderr',
    })
    const { deps, exec } = makeDeps({ exec: async () => { throw failure } })

    await expect(applyAccountHubUpdate(deps)).rejects.toThrow('pnpm remove failed')
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('快照恢复的 writeFile 失败时仍抛原安装错误并记录 console.error', async () => {
    const failure = Object.assign(new Error('pnpm add failed'), {
      code: 1,
      stdout: 'add stdout',
      stderr: 'add stderr',
    })
    const { deps, files } = makeDeps({
      exec: async (_command, args) => {
        if (args[0] === 'remove') return { stdout: 'remove stdout', stderr: 'remove stderr' }
        files.set(LOCK_PATH, makeLockfile(LATEST_SHA))
        throw failure
      },
    })
    const originalWriteFile = deps.writeFile
    const writeFailure = new Error('snapshot write failed')
    deps.writeFile = async (path, content) => {
      if (path === LOCK_PATH) throw writeFailure
      await originalWriteFile(path, content)
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(applyAccountHubUpdate(deps)).rejects.toThrow(
        'pnpm add failed (code 1)\n\nstdout:\nremove stdout\nstderr:\nremove stderr\nstdout:\nadd stdout\nstderr:\nadd stderr',
      )
      expect(error).toHaveBeenCalledWith(expect.stringContaining('回滚文件失败'))
    } finally {
      error.mockRestore()
    }
  })

  it('成功路径只写入 allowBuilds 业务变更，不发生快照回写', async () => {
    const { deps, files } = makeDeps()
    const originalWriteFile = deps.writeFile
    const writes: Array<[string, string]> = []
    deps.writeFile = async (path, content) => {
      writes.push([path, content])
      await originalWriteFile(path, content)
    }

    await applyAccountHubUpdate(deps)

    expect(writes).toHaveLength(1)
    expect(writes[0]?.[0]).toBe(WORKSPACE_PATH)
    expect(writes[0]?.[1]).toContain(`dsh-account-hub@https://codeload.github.com/gurio-wine/dsh-account-hub/tar.gz/${LATEST_SHA}: true`)
  })
})
