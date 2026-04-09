const fs = require('fs')
const path = require('path')
const { logger } = require('./logger')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const resolveChromeProfilesRoot = (sessionFolderPath) =>
  path.resolve(sessionFolderPath, '.chrome-profiles')

/**
 * Linux: encerra processos cujo /proc/PID/cmdline contém a needle (ex.: user-data-dir absoluto ou flag wwebjs).
 * Limpeza usa o prefixo user-data-dir em <SESSIONS_PATH>/.chrome-profiles.
 * O marcador só conta junto com esse prefixo, para não matar Chrome de outra instância com o mesmo WWEBJS_BROWSER_MARKER.
 */
const killMatchingPidsLinux = async (profileRoot, marker) => {
  if (process.platform !== 'linux') {
    return { platform: process.platform, killed: [], skipped: true }
  }
  const procBase = '/proc'
  const profileNeedle = `user-data-dir=${profileRoot}`
  const markerNeedle = `--wwebjs-app-marker=${marker}`
  const matches = new Set()
  let dirents
  try {
    dirents = await fs.promises.readdir(procBase)
  } catch (err) {
    logger.error({ err }, 'browserOrphans: não foi possível ler /proc')
    return { killed: [], error: err.message }
  }

  for (const ent of dirents) {
    if (!/^\d+$/.test(ent)) continue
    const cmdPath = path.join(procBase, ent, 'cmdline')
    let buf
    try {
      buf = await fs.promises.readFile(cmdPath)
    } catch {
      continue
    }
    const cmd = buf.toString('latin1').replace(/\0/g, ' ')
    const looksLikeBrowser =
      /chrome|chromium|Chrome|google-chrome/i.test(cmd) ||
      cmd.includes('puppeteer')
    const hitProfile = cmd.includes(profileNeedle)
    const hitMarker =
      cmd.includes(markerNeedle) &&
      looksLikeBrowser &&
      cmd.includes(profileRoot)
    if (!hitProfile && !hitMarker) continue
    matches.add(parseInt(ent, 10))
  }

  if (matches.size === 0) {
    return { killed: [] }
  }

  const sorted = [...matches].sort((a, b) => b - a)
  for (const pid of sorted) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      logger.debug({ pid, err: err.message }, 'browserOrphans: SIGTERM ignorado')
    }
  }
  await sleep(2500)
  const still = []
  for (const pid of sorted) {
    try {
      process.kill(pid, 0)
      still.push(pid)
    } catch {
      /* processo sumiu */
    }
  }
  for (const pid of still) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err) {
      logger.debug({ pid, err: err.message }, 'browserOrphans: SIGKILL ignorado')
    }
  }
  return { killed: sorted }
}

/**
 * Qualquer substring aqui basta (OR): perfil sob SESSIONS_PATH ou flag exclusiva desta instância.
 */
const cleanupOrphanBrowsers = async ({ sessionFolderPath, marker }) => {
  if (process.platform === 'win32') {
    logger.warn('browserOrphans: limpeza automática no Windows não está implementada; use STOP nas sessões ou encerre manualmente o Chrome filho do Node')
    return { killed: [], skipped: 'win32' }
  }
  if (process.platform === 'darwin') {
    logger.warn('browserOrphans: no macOS a limpeza por /proc não existe; defina WWEBJS_BROWSER_MARKER e use monitoreamento manual se necessário')
    return { killed: [], skipped: 'darwin' }
  }
  const profileRoot = resolveChromeProfilesRoot(sessionFolderPath)
  const result = await killMatchingPidsLinux(profileRoot, marker)
  return {
    ...result,
    profileRoot,
    markerSet: !!marker
  }
}

module.exports = {
  cleanupOrphanBrowsers,
  resolveChromeProfilesRoot
}
