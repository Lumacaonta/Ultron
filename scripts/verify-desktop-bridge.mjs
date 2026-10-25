import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

function expectIncludes(content, value, message) {
  assert.ok(content.includes(value), message)
}

const main = source('desktop/main.cjs')
const preload = source('desktop/preload.cjs')
const auth = source('frontend/src/auth.js')
const authGate = source('frontend/src/components/AuthGate.jsx')

for (const [value, message] of [
  ['preload: PRELOAD_PATH', 'The Electron preload is not configured.'],
  ['nodeIntegration: false', 'Renderer Node.js access must stay disabled.'],
  ['contextIsolation: true', 'Electron context isolation must stay enabled.'],
  ['sandbox: true', 'The renderer sandbox must stay enabled.'],
  ["'ultron:sync-session-token'", 'The authenticated desktop-session bridge is missing.'],
  ["'ultron:clear-session-token'", 'The desktop-session cleanup bridge is missing.'],
  ["'/api/models/register'", 'The native model registration route is missing.'],
  ["'Authorization': `Bearer ${backendSessionToken}`", 'Native model registration must use the signed-in session.'],
  ["'X-Ultron-Desktop-Picker': backendDesktopPickerSecret", 'Native model registration must require the desktop capability.'],
  ['requireTrustedRendererEvent(event)', 'Native picker IPC must validate its sender.'],
]) {
  expectIncludes(main, value, message)
}

for (const [value, message] of [
  ['syncSessionToken:', 'The preload does not expose session synchronization.'],
  ['clearSessionToken:', 'The preload does not expose session cleanup.'],
  ['selectModel:', 'The preload does not expose native model selection.'],
  ['selectExternalApp:', 'The preload does not expose native external-app selection.'],
  ['selectSkillApp:', 'The preload does not expose native skill-app selection.'],
]) {
  expectIncludes(preload, value, message)
}

assert.equal(
  /ipcRenderer\.send\(/.test(preload),
  false,
  'The preload must not expose fire-and-forget raw IPC.'
)
assert.equal(
  /require\(['"](?:fs|child_process|path|os)['"]\)/.test(preload),
  false,
  'The preload must not expose local filesystem or process APIs.'
)

expectIncludes(auth, 'setItem(SESSION_TOKEN_KEY, value)', 'The access token must stay session-scoped.')
expectIncludes(auth, 'syncDesktopSessionToken(token)', 'The renderer must synchronize the active session with Electron.')
expectIncludes(auth, 'clearDesktopSessionToken()', 'The renderer must clear the Electron session on logout.')
expectIncludes(authGate, 'await setSessionToken(result.token)', 'Authentication must synchronize the session before opening the app.')

console.log('ULTRON desktop bridge security contract verified')
