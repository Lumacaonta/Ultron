import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const require = createRequire(import.meta.url)
const forgeConfig = require(path.join(projectRoot, 'desktop', 'forge.config.cjs'))
const desktopPackage = require(path.join(projectRoot, 'desktop', 'package.json'))

const makers = Array.isArray(forgeConfig.makers)
  ? forgeConfig.makers
  : []
const portableMaker = makers.find(
  maker => maker.name === '@electron-forge/maker-zip'
)
const installerMaker = makers.find(
  maker => maker.name === '@electron-forge/maker-squirrel'
)

assert.ok(portableMaker, 'Windows portable ZIP maker is missing.')
assert.ok(
  portableMaker.platforms?.includes('win32'),
  'Portable ZIP maker must target win32.'
)
assert.ok(installerMaker, 'Windows Squirrel installer maker is missing.')
assert.ok(
  installerMaker.platforms?.includes('win32'),
  'Squirrel installer must target win32.'
)
assert.equal(
  installerMaker.config?.exe,
  'ULTRON ai.exe',
  'Squirrel must install the packaged ULTRON executable.'
)
assert.equal(
  installerMaker.config?.noMsi,
  true,
  'ULTRON publishes one explicit Setup.exe installer.'
)
assert.ok(
  fs.existsSync(path.join(projectRoot, 'desktop', 'assets', 'ultron-apple-black.ico')),
  'Windows icon is missing.'
)
assert.equal(
  typeof desktopPackage.scripts?.['package:win'],
  'string',
  'Windows package script is missing.'
)
assert.equal(
  typeof desktopPackage.scripts?.['make:win'],
  'string',
  'Windows installer script is missing.'
)
for (const script of [
  'bootstrap-windows.ps1',
  'build-windows.ps1',
  'verify-windows-package.ps1',
  'release-windows-x64.ps1',
]) {
  assert.ok(
    fs.existsSync(path.join(projectRoot, 'scripts', script)),
    `Windows packaging script is missing: ${script}`
  )
}

const buildScript = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'build-windows.ps1'),
  'utf8'
)
const releaseScript = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'release-windows-x64.ps1'),
  'utf8'
)
const verificationWorkflow = fs.readFileSync(
  path.join(projectRoot, '.github', 'workflows', 'verify.yml'),
  'utf8'
)
assert.ok(
  buildScript.includes("$DesktopMake = Join-Path $DesktopOut 'make'"),
  'Windows build output must use Electron Forge’s desktop/out/make directory.'
)
assert.ok(
  releaseScript.includes("out\\make\\squirrel.windows\\x64"),
  'Windows release script must collect the Squirrel installer from desktop/out/make.'
)
assert.ok(
  releaseScript.includes("out\\make\\zip\\win32\\x64"),
  'Windows release script must collect the portable ZIP from desktop/out/make.'
)
assert.ok(
  verificationWorkflow.includes('desktop/out/make/squirrel.windows/x64/*') &&
    verificationWorkflow.includes('desktop/out/make/zip/win32/x64/*'),
  'Windows CI must upload the Electron Forge output from desktop/out/make.'
)

const packageVerifier = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'verify-windows-package.ps1'),
  'utf8'
)
assert.ok(
  packageVerifier.includes("-replace '^/+', ''"),
  'The Windows package verifier must canonicalize root-relative asar entry paths.'
)
assert.ok(
  packageVerifier.includes('$entry = $_.Trim().Replace('),
  'The Windows package verifier must normalize asar path separators.'
)

console.log('ULTRON Windows packaging configuration verified')
