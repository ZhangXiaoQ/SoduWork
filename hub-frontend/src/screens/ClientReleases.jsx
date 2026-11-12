import { translateText as tx, localeMap, useLocale } from '../i18n.js'
/*
 * Manage signed client releases: list versions, upload manifest and installer pairs, and
 * enable or disable staged releases. Uploads start disabled; enablement requires server
 * signature and integrity checks.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, can } from '../api.js'
import { Icon, Loading, Modal, Confirm, toast } from '../ui.jsx'
import './client-releases.css'

const PLATFORM_META = {
  win32: { label: 'Windows', mark: 'W' },
  darwin: { label: 'macOS', mark: 'M' },
  linux: { label: 'Linux', mark: 'L' },
  android: { label: 'Android', mark: 'A' },
}

const ATTEMPT_STATE_META = localeMap(() => ({
  queued: { label: '排队中', tone: 'wait' },
  available: { label: '可更新', tone: 'wait' },
  downloading: { label: '下载中', tone: 'busy' },
  downloaded: { label: '已下载', tone: 'busy' },
  waiting: { label: '等待安装', tone: 'busy' },
  installing: { label: '安装中', tone: 'busy' },
  deferred: { label: '已推迟', tone: 'wait' },
  installed: { label: '已安装', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
}))

const ATTEMPT_STATE_ORDER = ['installed', 'downloading', 'installing', 'waiting',
  'downloaded', 'available', 'queued', 'deferred', 'failed']

function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (!n) return '—'
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/* Compare numeric version segments; invalid segments become zero. */
function parseVersion(value) {
  return String(value || '').split(/[.\-+]/).map((part) => parseInt(part, 10) || 0)
}

function newerVersion(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (va[i] || 0) - (vb[i] || 0)
    if (diff) return diff
  }
  return 0
}

const PLATFORM_ORDER = { win32: 0, darwin: 1, linux: 2, android: 3 }
const FORMAT_ORDER = [['.exe', 0], ['.dmg', 1], ['.deb', 2], ['.rpm', 3], ['.tar.gz', 4], ['.appimage', 5]]

function formatRank(name) {
  const lowered = String(name || '').toLowerCase()
  for (const [suffix, order] of FORMAT_ORDER) {
    if (lowered.endsWith(suffix)) return order
  }
  return FORMAT_ORDER.length
}

/*
 * Group platform artifacts under each version, newest first.
 */
function groupReleases(releases) {
  const byKey = new Map()
  for (const row of releases) {
    const key = `${row.version}\u0000${row.channel || 'stable'}`
    if (!byKey.has(key)) {
      byKey.set(key, { key, version: row.version, channel: row.channel || 'stable', rows: [] })
    }
    byKey.get(key).rows.push(row)
  }
  const groups = [...byKey.values()]
  for (const group of groups) {
    group.rows.sort((a, b) =>
      ((PLATFORM_ORDER[a.platform] ?? 9) - (PLATFORM_ORDER[b.platform] ?? 9)) ||
      (formatRank(a.artifactName) - formatRank(b.artifactName)))
  }
  return groups.sort((x, y) =>
    (newerVersion(y.version, x.version)) ||
    ((x.channel === 'stable' ? 0 : 1) - (y.channel === 'stable' ? 0 : 1)))
}

function fmtTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function ClientReleases() {
  const uiLocale = useLocale();
  const [releases, setReleases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [confirmEnable, setConfirmEnable] = useState(null)   // Release awaiting enablement.
  const [toggling, setToggling] = useState('')
  const [downloading, setDownloading] = useState('')
  // Per-device update version and stage.
  const [attempts, setAttempts] = useState([])
  const [counts, setCounts] = useState({})
  const [attemptsLoading, setAttemptsLoading] = useState(true)
  const [releaseFilter, setReleaseFilter] = useState('')
  const [stateFilter, setStateFilter] = useState('all')
  const manage = can('client.update')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [data, localized] = await Promise.all([api.clientReleases(), api.clientReleaseNotes().catch(error => {
        if (error.status === 404) return { notes: [] }; // Rolling upgrade: older Hub.
        throw error;
      })]);
      const byVersion = new Map((localized.notes || []).map(row => [row.version + '/' + row.channel, row]));
      setReleases((Array.isArray(data?.releases) ? data.releases : []).map(row => ({ ...row,
        localizedNotes: byVersion.get(row.version + '/' + row.channel)?.locales })))
    } catch (e) {
      setError(e.message || tx("版本列表没有加载出来"))
    }
    setLoading(false)
  }, [])

  const loadAttempts = useCallback(async () => {
    setAttemptsLoading(true)
    try {
      const data = await api.clientUpdateAttempts({ releaseId: releaseFilter, state: stateFilter })
      setAttempts(Array.isArray(data && data.attempts) ? data.attempts : [])
      setCounts((data && data.counts) || {})
    } catch (e) {
      // Update-activity failure must not block the release list.
      setAttempts([])
      setCounts({})
    }
    setAttemptsLoading(false)
  }, [releaseFilter, stateFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadAttempts() }, [loadAttempts])
  // Poll active update progress every ten seconds.
  useEffect(() => {
    const timer = setInterval(loadAttempts, 10000)
    return () => clearInterval(timer)
  }, [loadAttempts])

  async function toggle(row, enabled) {
    setToggling(row.id)
    try {
      await api.setClientReleaseEnabled(row.id, enabled)
      toast(enabled ? tx("已启用 {0}（{1}）", [row.version, row.platform]) : tx("已停用 {0}（{1}）", [row.version, row.platform]))
      setConfirmEnable(null)
      load()
    } catch (e) {
      toast(tx("操作失败：") + (e.message || tx("请稍后重试")))
    }
    setToggling('')
  }

  return <section className="pg-work-panel cr-page" aria-label={tx("客户端版本发布")}>
    <div className="cr-head">
      <div>
        <h2>{tx("客户端发布")}</h2>
        <p>{tx("管理桌面与 Android 安装包。上传后默认停用；启用前服务端会重新校验签名与完整性。")}</p>
      </div>
      {manage && <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
        <Icon name="plus" /> {tx("上传发布")}
      </button>}
    </div>

    {loading ? <Loading /> : error ? <div className="cr-error">{error}</div> :
      releases.length ? <div className="cr-list" role="region" aria-label={tx("版本列表")}>
        <div className="cr-table-head" role="row">
          <span>{tx("平台")}</span><span>{tx("安装包")}</span>
          <span>{tx("SHA-256")}</span><span>{tx("状态")}</span><span>{tx("发布时间")}</span><span>{tx("操作")}</span>
        </div>
        {groupReleases(releases).map((group) => {
          const enabledCount = group.rows.filter((row) => row.enabled).length
          const times = group.rows.map((row) => row.createdAt).filter(Boolean).sort()
          return <div key={group.key} className="cr-group">
            <div className="cr-group-head">
              <span className="cr-version">
                <b>v{group.version}</b>
                <small>{group.channel === 'stable' ? tx("正式渠道") : group.channel}</small>
              </span>
              <span className="cr-group-meta">
                {tx("{0} 个安装包", [group.rows.length])}
                <i>·</i>{tx("已启用 {0}", [enabledCount])}
                <i>·</i>{fmtTime(times.length ? times[times.length - 1] : '')}
              </span>
            </div>
            {[...new Set(group.rows.map(row => {
              const content = row.localizedNotes?.[uiLocale] || row.localizedNotes?.['en-US'];
              return content ? [content.summary, ...content.sections.flatMap(s =>
                [s.title, ...s.items.map(i => '• ' + i.text)])].join('\n') : row.notes;
            }).filter(Boolean))].map(notes =>
              <details className="cr-notes" key={notes}>
                <summary>{tx("更新内容")}</summary><div data-user-content>{notes}</div>
              </details>)}
            {group.rows.map((row) => {
              const plat = PLATFORM_META[row.platform] || { label: row.platform || '?', mark: '?' }
              return <div key={row.id} className="cr-row">
                <span className="cr-platform">
                  <i className="cr-mark">{plat.mark}</i>{plat.label}<small className="cr-arch">{row.arch}</small>
                </span>
                <span className="cr-artifact" title={row.artifactName}>
                  <b>{row.artifactName}</b>
                  <small>{fmtSize(row.artifactSize)}</small>
                </span>
                <span className="cr-sha" title={row.sha256}>{String(row.sha256 || '').slice(0, 10) || '—'}</span>
                <span className="cr-state">
                  {row.enabled
                    ? <i className="cr-flag on">{tx("已启用")}</i>
                    : <i className="cr-flag">{tx("已停用")}</i>}
                </span>
                <span className="cr-time">{fmtTime(row.createdAt)}</span>
                <span className="cr-actions">
                  {manage && <button className="admin-text-action" disabled={!!downloading}
                    onClick={async () => {
                      setDownloading(row.id)
                      try { await api.downloadClientRelease(row.id, row.artifactName) }
                      catch (error) { toast(error.message || tx("请稍后重试")) }
                      finally { setDownloading('') }
                    }}>{tx(downloading === row.id ? "下载中" : "下载")}</button>}
                  {manage && (row.enabled
                    ? <button className="admin-text-action" disabled={toggling === row.id}
                        onClick={() => toggle(row, false)}>{tx("停用")}</button>
                    : <button className="admin-text-action" disabled={toggling === row.id}
                        onClick={() => setConfirmEnable(row)}>{tx("启用")}</button>)}
                </span>
              </div>
            })}
          </div>
        })}
      </div>
      : <div className="cr-empty">
        <span><Icon name="box" /></span>
        <b>{tx("还没有发布任何版本")}</b>
        <p>{tx("点右上角「上传发布」，选择签名清单和安装包；也可以继续用 ops 脚本从构建机直传。")}</p>
      </div>}

    {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} onDone={() => { setUploadOpen(false); load() }} />}
    {confirmEnable && <Confirm
      title={tx("启用该版本？")}
      text={confirmEnable.platform === 'android'
        ? tx("启用后可从首页下载此 Android 安装包；停用后下载入口将不可用。已有安装不会被卸载。")
        : tx("启用 {0}（{1} / {2}）后，对应平台的设备会在检查更新时收到升级。启用前服务端会重新校验签名与安装包完整性，校验失败将被拒绝。", [confirmEnable.version, confirmEnable.platform, confirmEnable.arch])}
      confirmText={tx("启用")}
      onConfirm={() => toggle(confirmEnable, true)}
      onClose={() => setConfirmEnable(null)} />}

    <AttemptsPanel
      releases={releases}
      attempts={attempts}
      counts={counts}
      loading={attemptsLoading}
      releaseFilter={releaseFilter}
      stateFilter={stateFilter}
      onReleaseFilter={setReleaseFilter}
      onStateFilter={setStateFilter}
      onRefresh={loadAttempts} />
  </section>
}

/* Show per-device update activity after release dispatch. */
function AttemptsPanel({ releases, attempts, counts, loading,
                         releaseFilter, stateFilter, onReleaseFilter, onStateFilter, onRefresh }) {
  const orderedCounts = ATTEMPT_STATE_ORDER
    .filter((s) => (counts[s] || 0) > 0)
    .map((s) => ({ state: s, n: counts[s], ...(ATTEMPT_STATE_META[s] || { label: s, tone: 'wait' }) }))
  return <div className="cr-attempts" role="region" aria-label={tx("升级动态")}>
    <div className="cr-attempts-head">
      <h3>{tx("升级动态")}</h3>
      <div className="cr-attempts-filters">
        <select value={releaseFilter} onChange={(e) => onReleaseFilter(e.target.value)}
          aria-label={tx("按版本筛选")}>
          <option value="">{tx("全部版本")}</option>
          {releases.map((row) => <option key={row.id} value={row.id}>v{row.version}（{row.platform}）</option>)}
        </select>
        <select value={stateFilter} onChange={(e) => onStateFilter(e.target.value)}
          aria-label={tx("按状态筛选")}>
          <option value="all">{tx("全部状态")}</option>
          <option value="active">{tx("进行中")}</option>
          {ATTEMPT_STATE_ORDER.map((s) =>
            <option key={s} value={s}>{ATTEMPT_STATE_META[s].label}</option>)}
        </select>
        <button className="admin-text-action" onClick={onRefresh}
          disabled={loading} aria-label={tx("刷新升级动态")}>
          {loading ? tx("刷新中…") : tx("刷新")}
        </button>
      </div>
    </div>
    {orderedCounts.length > 0 && <div className="cr-attempts-counts">
      {orderedCounts.map((row) =>
        <span key={row.state} className={`cr-count-badge is-${row.tone}`}>
          {row.label} {row.n}
        </span>)}
    </div>}
    {attempts.length ? <div className="cr-attempts-list" role="rowgroup">
      <div className="cr-table-head cr-attempt-head" role="row">
        <span>{tx("设备")}</span><span>{tx("平台")}</span><span>{tx("版本")}</span>
        <span>{tx("状态")}</span><span>{tx("错误 / 时间")}</span>
      </div>
      {attempts.map((row) => {
        const meta = ATTEMPT_STATE_META[row.state] || { label: tx(row.state), tone: 'wait' }
        const plat = PLATFORM_META[row.releasePlatform || row.clientPlatform]
          || { label: row.releasePlatform || row.clientPlatform || '?', mark: '?' }
        return <div key={row.id} className="cr-attempt-row" role="row">
          <span className="cr-att-device" title={row.clientId}>
            <i className={`cr-online ${row.clientOnline ? 'on' : ''}`}
              title={row.clientOnline ? tx("在线") : tx("离线")} />
            <b>{row.clientName || row.clientId}</b>
          </span>
          <span className="cr-att-platform">
            <i className="cr-mark">{plat.mark}</i>{plat.label}
          </span>
          <span className="cr-att-version">
            {row.currentVersion && row.currentVersion !== row.targetVersion
              ? `v${row.currentVersion} → v${row.targetVersion}`
              : `v${row.targetVersion}`}
          </span>
          <span className="cr-att-state">
            <i className={`cr-flag ${row.state === 'installed' ? 'on' : row.state === 'failed' ? 'bad' : ''}`}>{meta.label}</i>
            {meta.tone === 'busy' && row.state !== 'failed' &&
              <span className="cr-att-progress" aria-hidden="true">
                <i style={{ width: `${Math.max(4, row.progress || 0)}%` }} />
              </span>}
          </span>
          <span className="cr-att-error" title={row.error || ''}>
            {row.error || fmtTime(row.updatedAt)}
          </span>
        </div>
      })}
    </div>
    : <div className="cr-attempts-empty">
      <b>{tx("还没有升级任务")}</b>
      <p>{tx("设备在检查更新时会收到启用的版本；也可以在设备详情里手动下发升级。")}</p>
    </div>}
  </div>
}

/* Upload signed manifest and installer together; prevent dismissal while transfer is active. */
function UploadModal({ onClose, onDone }) {
  const uiLocale = useLocale();
  const bundleRef = useRef(null)
  const installerRef = useRef(null)
  const [bundleName, setBundleName] = useState('')
  const [installerName, setInstallerName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    const bundle = bundleRef.current && bundleRef.current.files[0]
    const installer = installerRef.current && installerRef.current.files[0]
    if (!bundle) { setError(tx("请选择签名清单（bundle.json）")); return }
    if (!installer) { setError(tx("请选择安装包文件")); return }
    setBusy(true)
    setError('')
    try {
      const data = await api.uploadClientRelease(bundle, installer)
      const rel = data && data.release
      toast(rel
        ? tx("已上传 {0}（{1} / {2}），当前为停用状态，确认后请点「启用」", [rel.version, rel.platform, rel.arch])
        : tx("上传成功"))
      onDone()
    } catch (e) {
      setError(e.message || tx("上传失败，请稍后重试"))
    }
    setBusy(false)
  }

  return <Modal title={tx("上传客户端发布")} icon="send" onClose={busy ? undefined : onClose}
    foot={<>
      <button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx("取消")}</button>
      <button className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? tx("上传中，安装包较大请稍候…") : tx("上传")}
      </button>
    </>}>
    <div className="cr-upload">
      <p className="cr-upload-hint">{tx("安装包需已按发布流程签名。上传后默认停用，启用时服务端会重验签名与完整性。")}</p>
      <label className="cr-file-field">
        <span>{tx("签名清单（bundle.json）")}</span>
        <input ref={bundleRef} type="file" accept=".json,application/json" disabled={busy} className="cr-file-native"
          onChange={(e) => setBundleName(e.target.files[0] ? e.target.files[0].name : '')} />
        <span className="cr-file-row">
          <span className="cr-file-chip btn btn-ghost xs" aria-hidden="true">{tx("选择文件")}</span>
          <span className="cr-file-name">{bundleName || tx("未选择任何文件")}</span>
        </span>
        <small>{tx("签名上传脚本输出的 .json 清单")}</small>
      </label>
      <label className="cr-file-field">
        <span>{tx("安装包")}</span>
        <input ref={installerRef} type="file" disabled={busy} className="cr-file-native"
          onChange={(e) => setInstallerName(e.target.files[0] ? e.target.files[0].name : '')} />
        <span className="cr-file-row">
          <span className="cr-file-chip btn btn-ghost xs" aria-hidden="true">{tx("选择文件")}</span>
          <span className="cr-file-name">{installerName || tx("未选择任何文件")}</span>
        </span>
        <small>{tx("SoduWork-x.y.z-Setup.exe / .dmg / .deb / .rpm / .tar.gz / .AppImage")} / SoduWork-Mobile-x.y.z.apk</small>
      </label>
      {error && <div className="cr-upload-error">{error}</div>}
    </div>
  </Modal>
}
