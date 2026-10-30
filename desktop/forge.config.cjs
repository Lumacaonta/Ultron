const path = require('path')
const { execFileSync } = require('child_process')

const signingIdentity = (
  process.env.ULTRON_CODESIGN_IDENTITY || ''
).trim()
const productionSigning = (
  signingIdentity.length > 0 &&
  signingIdentity !== '-'
)
const shouldNotarize = (
  process.env.ULTRON_NOTARIZE === '1'
)

if (shouldNotarize && !productionSigning) {
  throw new Error(
    'ULTRON_NOTARIZE=1 requires ULTRON_CODESIGN_IDENTITY.'
  )
}

const notaryCredentials = {
  appleId: process.env.ULTRON_APPLE_ID,
  appleIdPassword: (
    process.env.ULTRON_APPLE_APP_SPECIFIC_PASSWORD
  ),
  teamId: process.env.ULTRON_APPLE_TEAM_ID,
}

if (
  shouldNotarize &&
  Object.values(notaryCredentials).some(
    value => !value || !value.trim()
  )
) {
  throw new Error(
    'Notarization requires ULTRON_APPLE_ID, ' +
    'ULTRON_APPLE_APP_SPECIFIC_PASSWORD and ' +
    'ULTRON_APPLE_TEAM_ID.'
  )
}

const mainEntitlements = path.join(
  __dirname,
  'entitlements.mac.plist'
)

/*
 * Windows packages can be built without a certificate for tester candidates.
 * A public production installer uses the same certificate for Electron's EXE
 * files and Squirrel's Setup.exe.  Refuse a half-configured signing request so
 * a release job cannot accidentally claim a signed package when only one
 * secret was supplied.
 */
const windowsCertificateFile = (
  process.env.ULTRON_WINDOWS_CERTIFICATE_FILE || ''
).trim()
const windowsCertificatePassword = (
  process.env.ULTRON_WINDOWS_CERTIFICATE_PASSWORD || ''
).trim()
const productionWindowsSigning = (
  windowsCertificateFile.length > 0 &&
  windowsCertificatePassword.length > 0
)

if (
  Boolean(windowsCertificateFile) !==
  Boolean(windowsCertificatePassword)
) {
  throw new Error(
    'Windows signing requires both ULTRON_WINDOWS_CERTIFICATE_FILE and ' +
    'ULTRON_WINDOWS_CERTIFICATE_PASSWORD.'
  )
}

const windowsSignOptions = productionWindowsSigning
  ? {
      certificateFile: windowsCertificateFile,
      certificatePassword: windowsCertificatePassword,
      timestampServer: (
        process.env.ULTRON_WINDOWS_TIMESTAMP_SERVER ||
        'http://timestamp.digicert.com'
      ).trim(),
      hash: 'sha256',
    }
  : undefined

const windowsIcon = path.join(
  __dirname,
  'assets',
  'ultron-apple-black.ico'
)

/*
 * Electron's stock macOS template advertises camera and Bluetooth access and
 * permits arbitrary network loads. ULTRON does not need any of those. Remove
 * the template metadata before Electron Packager reads and signs Info.plist;
 * the microphone explanation below is the only user-facing media permission
 * that remains in the shipped bundle.
 */
function hardenMacTemplatePlist({
  buildPath,
  platform,
}) {
  if (platform !== 'darwin') {
    return
  }

  const plistPath = path.resolve(
    buildPath,
    '..',
    '..',
    'Info.plist'
  )
  const plistBuddy = '/usr/libexec/PlistBuddy'

  for (const key of [
    'NSCameraUsageDescription',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
  ]) {
    try {
      execFileSync(
        plistBuddy,
        ['-c', `Delete :${key}`, plistPath],
        { stdio: 'ignore' }
      )
    } catch {
      // The Electron template can omit a key on a future runtime version.
    }
  }

  execFileSync(
    plistBuddy,
    [
      '-c',
      'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false',
      plistPath,
    ],
    { stdio: 'ignore' }
  )
}

module.exports = {
  packagerConfig: {
    name: 'Ultron AI',
    executableName: 'Ultron AI',
    appBundleId: 'io.ultronai.desktop',
    appCategoryType: 'public.app-category.productivity',
    darwinDarkModeSupport: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Ultron AI uses the microphone only when you start voice input.',
    },
    asar: true,
    afterInitialize: [hardenMacTemplatePlist],
    // The shell needs main.cjs, preload.cjs and package.json inside app.asar. Runtime
    // frontend/backend resources are copied below with extraResource, so keep
    // generated files, development tooling, and historic recovery copies out
    // of every distributable package.
    ignore: [
      /\/(?:node_modules|assets|resources|out|make|release)(?:\/|$)/,
      /\/(?:forge\.config\.cjs|ultron\.png)$/,
      /\/.*\.(?:backup|bak|orig|rej)$/,
      /\/.*\.before-[^/]*$/,
      /\/.*\.corrupted-[^/]*$/,
      /\/\.env(?:\..*)?$/,
      /\/.*\.(?:db|sqlite|sqlite3)(?:-.*)?$/,
      /\/(?:backend\.log|\.DS_Store)$/,
    ],
    // Electron Packager resolves this extensionless path to the native
    // .icns on macOS and the matching .ico on Windows.
    icon: path.join(
      __dirname,
      'assets',
      'ultron-apple-black'
    ),
    win32metadata: {
      CompanyName: 'Ultron AI contributors',
      FileDescription: 'Ultron AI local-first workspace',
      ProductName: 'Ultron AI',
      InternalName: 'ultron-ai',
      'requested-execution-level': 'asInvoker',
    },
    windowsSign: productionWindowsSigning
      ? {
          ...windowsSignOptions,
          continueOnError: false,
        }
      : undefined,

    // Forge signs every discovered executable in a production package. The
    // primary Electron executable receives only the capabilities ULTRON uses;
    // child processes keep Electron's maintained default entitlements.
    osxSign: productionSigning
      ? {
          identity: signingIdentity,
          hardenedRuntime: true,
          strictVerify: true,
          continueOnError: false,
          optionsForFile: filePath => {
            if (
              filePath.endsWith(
                path.join('MacOS', 'Ultron AI')
              )
            ) {
              return { entitlements: mainEntitlements }
            }

            return {}
          },
        }
      : undefined,

    osxNotarize: shouldNotarize
      ? {
          tool: 'notarytool',
          ...notaryCredentials,
        }
      : undefined,

    extraResource: [
      path.join(
        __dirname,
        'resources',
        'frontend'
      ),

      path.join(
        __dirname,
        'resources',
        'backend'
      ),

      // macOS reads the ICNS assigned by Electron Packager for the app bundle;
      // use this PNG at runtime too so Dock refreshes work reliably.
      path.join(
        __dirname,
        'assets',
        'ultron-apple-black.png'
      )
    ]
  },

  makers: [
    {
      name:
        '@electron-forge/maker-zip',

      // A portable ZIP is useful both on macOS and Windows. It contains the
      // same bundled local backend as the installer and needs no Python or
      // Node.js on the recipient's computer.
      platforms: [
        'darwin',
        'win32',
      ],
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'ultron_ai',
        exe: 'Ultron AI.exe',
        noMsi: true,
        setupExe: 'Ultron-AI-Setup.exe',
        setupIcon: windowsIcon,
        // This stays absent for an unsigned candidate. When CI receives the
        // two certificate secrets it signs Setup.exe and Squirrel artifacts
        // with SHA-256 and a timestamp as part of the same build.
        windowsSign: windowsSignOptions,
      },
    },
  ]
}
