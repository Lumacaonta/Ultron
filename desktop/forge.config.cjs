const path = require('path')

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

module.exports = {
  packagerConfig: {
    name: 'ULTRON ai',
    executableName: 'ULTRON ai',
    appBundleId: 'io.ultronai.desktop',
    asar: true,
    // The shell needs only main.cjs and package.json inside app.asar. Runtime
    // frontend/backend resources are copied below with extraResource, so keep
    // generated files, development tooling, and historic recovery copies out
    // of every distributable package.
    ignore: [
      /\/(?:node_modules|assets|resources|out|make)(?:\/|$)/,
      /\/(?:forge\.config\.cjs|ultron\.png)$/,
      /\/.*\.(?:backup|bak|orig|rej)$/,
      /\/.*\.before-[^/]*$/,
      /\/.*\.corrupted-[^/]*$/,
      /\/\.env(?:\..*)?$/,
      /\/.*\.(?:db|sqlite|sqlite3)(?:-.*)?$/,
      /\/(?:backend\.log|\.DS_Store)$/,
    ],
    icon: path.join(
      __dirname,
      'assets',
      'ultron-apple-black'
    ),

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
                path.join('MacOS', 'ULTRON ai')
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

      platforms: [
        'darwin'
      ]
    }
  ]
}
