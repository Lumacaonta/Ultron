import * as THREE from 'three'
import DevicesPage from './components/DevicesPage.jsx'
import MemoryPage from './components/MemoryPage.jsx'
import SettingsPage from './components/SettingsPage.jsx'
import OnboardingTutorial from './components/OnboardingTutorial.jsx'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from './auth.js'
import './App.css'

const ModelDeckPage = lazy(() => import('./components/ModelDeckPage.jsx'))

const INITIAL_CHAT_TIMESTAMP = Date.now()

const DEFAULT_PREFERENCES = {
  scale: 100,
  motionEnabled: true,
  voiceEnabled: true,
}

const DEFAULT_WEATHER_CONFIG = {
  label: 'LOCAL AREA',
  lat: '',
  lon: '',
}

const NAVIGATION_ITEMS = [
  { id: 'AGENT', label: 'Agent', icon: 'agent' },
  { id: 'MEMORY', label: 'Memory', icon: 'memory' },
  { id: 'DEVICES', label: 'Devices', icon: 'devices' },
  { id: 'SETTINGS', label: 'Settings', icon: 'settings' },
]

function loadPreferences(storageKey) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) || '{}'
    )

    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function loadWeatherConfig(storageKey) {
  try {
    const saved = localStorage.getItem(storageKey)

    if (!saved) return { ...DEFAULT_WEATHER_CONFIG }

    const config = JSON.parse(saved)
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ...DEFAULT_WEATHER_CONFIG }
    }

    return {
      label: typeof config.label === 'string' ? config.label : DEFAULT_WEATHER_CONFIG.label,
      lat: config.lat ?? '',
      lon: config.lon ?? '',
    }
  } catch {
    return { ...DEFAULT_WEATHER_CONFIG }
  }
}

const ONBOARDING_VERSION = '1'

function onboardingStorageKey(accountScope) {
  return `ultron-onboarding:${accountScope}:v${ONBOARDING_VERSION}`
}

function shouldShowOnboarding(accountScope) {
  try {
    return localStorage.getItem(onboardingStorageKey(accountScope)) !== 'complete'
  } catch {
    // A locked-down browser cannot remember completion, but the guide remains usable.
    return true
  }
}

function markOnboardingComplete(accountScope) {
  try {
    localStorage.setItem(onboardingStorageKey(accountScope), 'complete')
  } catch {
    // Do not block the interface if browser storage is unavailable.
  }
}

const CORE_NODES = [
  { id: 'operator', name: 'OPERATOR', relation: 'CORE', strength: 1.00, position: [0, 0, 0] },
  { id: 'local-ai', name: 'LOCAL AI', relation: 'assistant', strength: 0.82, position: [-1.35, 1.25, 0.6] },
  { id: 'knowledge', name: 'KNOWLEDGE VAULT', relation: 'indexed', strength: 0.72, position: [-2.25, 1.95, -0.35] },
  { id: 'local-host', name: 'LOCAL HOST', relation: 'runtime', strength: 0.80, position: [1.45, 1.45, 0.45] },
  { id: 'automation', name: 'AUTOMATION', relation: 'workflow', strength: 0.67, position: [2.35, 0.65, -0.5] },
  { id: 'local-model', name: 'LOCAL MODEL', relation: 'inference', strength: 0.67, position: [2.0, -0.55, 0.8] },
  { id: 'projects', name: 'PROJECTS', relation: 'workspace', strength: 0.62, position: [-1.7, -1.2, 0.75] },
  { id: 'obsidian', name: 'OBSIDIAN', relation: 'knowledge', strength: 0.75, position: [-0.2, 2.0, -0.9] },
  { id: 'devices', name: 'DEVICES', relation: 'local control', strength: 0.52, position: [0.25, -2.0, 0.55] },
  { id: 'integrations', name: 'INTEGRATIONS', relation: 'connected', strength: 0.38, position: [-0.95, -2.0, -0.7] },
  { id: 'printer', name: '3D FABRICATION', relation: 'printer', strength: 0.50, position: [2.35, -1.55, -0.7] },
  { id: 'browser', name: 'BROWSER', relation: 'local tool', strength: 0.32, position: [-2.45, 0.15, 0.9] },
  { id: 'code', name: 'CODE WORKSPACE', relation: 'development', strength: 0.36, position: [-2.55, -0.65, -0.25] },
  { id: 'terminal', name: 'LOCAL TERMINAL', relation: 'system', strength: 0.30, position: [0.9, 1.05, -1.6] },
  { id: 'network', name: 'PRIVATE NETWORK', relation: 'local link', strength: 0.29, position: [0.6, -0.8, -1.8] },
  { id: 'security', name: 'SECURITY', relation: 'protection', strength: 0.27, position: [-0.7, -1.0, -1.8] },
  { id: 'memory', name: 'MEMORY', relation: 'neural archive', strength: 0.45, position: [0.65, -1.25, 1.55] },
  { id: 'weather', name: 'WEATHER', relation: 'service', strength: 0.22, position: [-0.6, 1.05, 1.75] },
]

const SECONDARY_LINKS = [
  ['operator', 'local-ai'],
  ['operator', 'knowledge'],
  ['local-host', 'automation'],
  ['automation', 'local-model'],
  ['obsidian', 'memory'],
  ['devices', 'integrations'],
  ['local-model', 'network'],
  ['network', 'security'],
  ['local-host', 'terminal'],
  ['local-host', 'browser'],
  ['projects', 'code'],
]

const HIDDEN_DYNAMIC_NODE_KEYS = new Set([
  'html_site',
  'html site',
  'htmlsite',
  'by_itself',
  'by itself',
  'byitself',
  '1000x139219',
])

function normalizeGraphKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, '')
}

function isHiddenGraphNode(item = {}) {
  return [
    item.id,
    item.name,
    item.object,
    item.label,
    item.title,
  ].some(value => HIDDEN_DYNAMIC_NODE_KEYS.has(
    normalizeGraphKey(value)
  ))
}

function describeCoreNode(node = {}) {
  const name = String(node.name || '').trim()
  const staticNode = CORE_NODES.find(
    item => item.name.toLowerCase() === name.toLowerCase()
  )
  const base = staticNode || node
  const id = base.id || `node-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const linkCount = SECONDARY_LINKS.filter(([left, right]) => (
    left === id || right === id
  )).length

  return {
    id,
    name: base.name || 'UNKNOWN NODE',
    relation: base.relation || 'unclassified connection',
    strength: Number(base.strength ?? 0.5),
    type: base.type || (id === 'operator' ? 'SOVEREIGN CORE' : 'NEURAL ENTITY'),
    source: base.source || 'ULTRON MEMORY',
    description: base.description || `${base.name || 'This node'} is indexed in the ULTRON neural network.`,
    path: base.path || '',
    linkCount: Number(base.linkCount ?? linkCount),
  }
}

function createChatMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createChatMessageTimestamp() {
  return Date.now()
}

function hasStoredCoordinates(config = {}) {
  return [config?.lat, config?.lon].every(value => (
    value !== '' && value !== null && value !== undefined
  ))
}

function Brain3D({ onSelect }) {
  const mountRef = useRef(null)
  const animationRef = useRef(0)

  useEffect(() => {
    const mount = mountRef.current

    if (!mount) {
      return
    }

    const scene = new THREE.Scene()
    const nodeAmbientLight = new THREE.AmbientLight(0x5b1419, 1.55)
    const nodeKeyLight = new THREE.DirectionalLight(0xffd8d0, 2.1)
    nodeKeyLight.position.set(-2.4, 3.1, 5.2)
    const nodeRimLight = new THREE.PointLight(0xff322c, 1.7, 14, 2)
    nodeRimLight.position.set(3.6, -1.5, -3.2)
    scene.add(nodeAmbientLight, nodeKeyLight, nodeRimLight)

    const camera =
      new THREE.PerspectiveCamera(
        42,
        Math.max(
          1,
          mount.clientWidth
        ) /
          Math.max(
            1,
            mount.clientHeight
          ),
        0.1,
        200
      )

    camera.position.set(
      0,
      0,
      8.8
    )

    const renderer =
      new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference:
          "high-performance",
      })

    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio || 1,
        2
      )
    )

    renderer.setSize(
      Math.max(
        1,
        mount.clientWidth
      ),
      Math.max(
        1,
        mount.clientHeight
      )
    )

    renderer.setClearColor(
      0x000000,
      0
    )

    mount.appendChild(
      renderer.domElement
    )

    /*
     * IMPORTANT:
     * Controls are created exactly once.
     * Memory updates NEVER recreate them.
     */
    const controls =
      new OrbitControls(
        camera,
        renderer.domElement
      )

    controls.enableDamping = true
    controls.dampingFactor = 0.055
    controls.enablePan = false
    controls.enableRotate = true
    controls.enableZoom = true
    controls.minDistance = 5.2
    controls.maxDistance = 13
    controls.rotateSpeed = 0.58
    controls.zoomSpeed = 0.85

    const brain =
      new THREE.Group()

    /* Start with a slight tilt so the automatic drift immediately reads as a 3D object. */
    brain.rotation.set(
      0.12,
      -0.2,
      0.07
    )

    scene.add(brain)

    /*
     * Presentation layers deliberately sit around the existing neural graph.
     * They add the reactor-like visual language without changing data,
     * selection, rotation, zoom or graph layout.
     */
    const orbitalLayers = []
    const cortexLayers = []
    const architectureLayers = []
    const sphericalLayers = []

    const labels =
      new THREE.Group()

    const labelWorldPosition =
      new THREE.Vector3()

    scene.add(labels)

    const microNodes = []
    const semanticNodes = []
    const dynamicSemanticNodes = []
    const semanticMap = new Map()

    const positions = []

    const goldenAngle =
      Math.PI *
      (3 - Math.sqrt(5))

    const radius = 3.24
    const count = 620

    /*
     * Dense neural fabric
     */
    for (
      let i = 0;
      i < count;
      i += 1
    ) {
      const y =
        1 -
        (i / (count - 1)) * 2

      const ring =
        Math.sqrt(
          Math.max(
            0,
            1 - y * y
          )
        )

      const theta =
        goldenAngle * i

      const position =
        new THREE.Vector3(
          Math.cos(theta) *
            ring *
            radius,
          y * radius,
          Math.sin(theta) *
            ring *
            radius
        )

      positions.push(
        position
      )

      const material =
        new THREE.MeshBasicMaterial({
          color:
            Math.random() > 0.12
              ? 0xb51c1c
              : 0x650909,
          transparent: true,
          opacity:
            0.40 +
            Math.random() * 0.45,
        })

      const node =
        new THREE.Mesh(
          new THREE.SphereGeometry(
            0.023 +
              Math.random() * 0.032,
            6,
            6
          ),
          material
        )

      node.position.copy(
        position
      )

      node.userData.phase =
        Math.random() *
        Math.PI *
        2

      node.userData.baseOpacity =
        material.opacity

      brain.add(node)
      microNodes.push(node)
    }

    /*
     * Neural connections
     */
    const connectionPoints = []

    for (
      let i = 0;
      i < positions.length;
      i += 1
    ) {
      const neighbors = []

      for (
        let j =
          Math.max(
            0,
            i - 12
          );
        j <
        Math.min(
          positions.length,
          i + 13
        );
        j += 1
      ) {
        if (i === j) {
          continue
        }

        const distance =
          positions[i].distanceTo(
            positions[j]
          )

        if (distance < 0.82) {
          neighbors.push({
            index: j,
            distance,
          })
        }
      }

      neighbors
        .sort(
          (a, b) =>
            a.distance -
            b.distance
        )
        .slice(0, 3)
        .forEach(
          (neighbor) => {
            const a =
              positions[i]

            const b =
              positions[
                neighbor.index
              ]

            connectionPoints.push(
              a.x,
              a.y,
              a.z,
              b.x,
              b.y,
              b.z
            )
          }
        )
    }

    const connectionGeometry =
      new THREE.BufferGeometry()

    connectionGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        connectionPoints,
        3
      )
    )

    brain.add(
      new THREE.LineSegments(
        connectionGeometry,
        new THREE.LineBasicMaterial({
          color: 0x6b0a0a,
          transparent: true,
          opacity: 0.34,
        })
      )
    )

    /*
     * Dark cognitive shell and slow orbital architecture.
     * The sparse geometry preserves the readable network at the center.
     */
    const cortexShell =
      new THREE.Mesh(
        new THREE.IcosahedronGeometry(
          3.32,
          3
        ),
        new THREE.MeshBasicMaterial({
          color: 0x7d1016,
          wireframe: true,
          transparent: true,
          opacity: 0.13,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    cortexShell.scale.set(
      1.08,
      0.9,
      1
    )

    brain.add(cortexShell)
    cortexLayers.push(cortexShell)

    /*
     * Two close containment cages make the neural fabric feel constrained
     * and engineered. They sit just outside the live graph rather than
     * swelling into a decorative halo.
     */
    const containmentSpecs = [
      {
        radius: 3.29,
        rotation: [0.26, 0.58, 0.18],
        color: 0x8f1019,
        opacity: 0.31,
        speed: -0.0016,
      },
      {
        radius: 3.37,
        rotation: [1.04, -0.24, 0.74],
        color: 0xff3131,
        opacity: 0.20,
        speed: 0.0011,
      },
    ]

    containmentSpecs.forEach((spec) => {
      const cage =
        new THREE.LineSegments(
          new THREE.WireframeGeometry(
            new THREE.IcosahedronGeometry(
              spec.radius,
              1
            )
          ),
          new THREE.LineBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: spec.opacity,
            blending:
              THREE.AdditiveBlending,
            depthWrite: false,
          })
        )

      cage.scale.set(1.04, 0.88, 0.96)
      cage.rotation.set(...spec.rotation)
      cage.userData.speed = spec.speed

      brain.add(cage)
      orbitalLayers.push(cage)
    })

    /*
     * Exterior volume: several independently tilted polyhedral skins and a
     * field of beacons make the neural network read as a real object in
     * space. None of these layers is planar, so the depth stays visible
     * while the operator rotates the Core.
     */
    const exteriorShell = new THREE.Group()
    const sphereShells = [
      {
        geometry: new THREE.IcosahedronGeometry(3.26, 2),
        scale: [1.02, 0.94, 0.98],
        rotation: [0.3, -0.44, 0.12],
        color: 0xb41620,
        opacity: 0.26,
        speed: 0.00042,
      },
      {
        geometry: new THREE.DodecahedronGeometry(3.31, 1),
        scale: [0.96, 1.02, 1],
        rotation: [-0.68, 0.26, -0.38],
        color: 0xff3d3d,
        opacity: 0.18,
        speed: -0.00031,
      },
      {
        geometry: new THREE.IcosahedronGeometry(3.36, 1),
        scale: [1, 0.97, 1.01],
        rotation: [0.82, 0.61, 0.3],
        color: 0x7f1119,
        opacity: 0.30,
        speed: 0.00022,
      },
    ]

    sphereShells.forEach((spec) => {
      const shell = new THREE.LineSegments(
        new THREE.WireframeGeometry(spec.geometry),
        new THREE.LineBasicMaterial({
          color: spec.color,
          transparent: true,
          opacity: spec.opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

      shell.scale.set(...spec.scale)
      shell.rotation.set(...spec.rotation)
      shell.userData.speed = spec.speed
      exteriorShell.add(shell)
      sphericalLayers.push(shell)
    })

    const surfacePositions = []
    const surfaceColors = []
    const surfaceRadius = 3.30

    for (let index = 0; index < 520; index += 1) {
      const y = 1 - ((index + 0.5) / 520) * 2
      const radial = Math.sqrt(Math.max(0, 1 - y * y))
      const theta = goldenAngle * index * 1.13
      const radiusNoise = surfaceRadius + Math.sin(index * 2.17) * 0.1

      surfacePositions.push(
        Math.cos(theta) * radial * radiusNoise,
        y * radiusNoise * 0.94,
        Math.sin(theta) * radial * radiusNoise
      )

      const signal = index % 11 === 0 ? 1 : 0.42 + (index % 5) * 0.08
      surfaceColors.push(signal, signal * 0.08, signal * 0.09)
    }

    const surfaceGeometry = new THREE.BufferGeometry()
    surfaceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(surfacePositions, 3)
    )
    surfaceGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(surfaceColors, 3)
    )

    const surfaceBeacons = new THREE.Points(
      surfaceGeometry,
      new THREE.PointsMaterial({
        size: 0.06,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      })
    )

    surfaceBeacons.rotation.set(0.16, 0.28, -0.08)
    exteriorShell.add(surfaceBeacons)
    sphericalLayers.push(surfaceBeacons)

    brain.add(exteriorShell)

    /*
     * Angular scars cut through the sphere like a mechanical exoskeleton.
     * They deliberately use broken vectors and tetrahedra rather than rings,
     * making the core read as a constructed weapon instead of a planet.
     */
    const fractureArchitecture =
      new THREE.Group()

    const fractureSegments = []
    const fractureFragments = []

    for (
      let index = 0;
      index < 46;
      index += 1
    ) {
      const ratio =
        (index + 0.5) / 46

      const y =
        1 - ratio * 2

      const radial =
        Math.sqrt(
          Math.max(0.06, 1 - y * y)
        )

      const theta =
        goldenAngle * index * 1.47

      const direction =
        new THREE.Vector3(
          Math.cos(theta) * radial,
          y,
          Math.sin(theta) * radial
        ).normalize()

      const tangent =
        new THREE.Vector3(
          -direction.z,
          Math.sin(theta * 2.3) * 0.34,
          direction.x
        ).normalize()

      const inner =
        direction.clone().multiplyScalar(
          2.68 + (index % 4) * 0.09
        )

      const hinge =
        direction.clone().multiplyScalar(
          3.10 + (index % 5) * 0.08
        ).add(
          tangent.clone().multiplyScalar(
            index % 2 ? 0.25 : -0.2
          )
        )

      const outer =
        direction.clone().multiplyScalar(
          3.36 + (index % 4) * 0.05
        ).add(
          tangent.clone().multiplyScalar(
            index % 3 === 0 ? 0.16 : -0.12
          )
        )

      fractureSegments.push(
        inner,
        hinge,
        hinge,
        outer
      )

      if (index % 2 === 0) {
        const fragment =
          new THREE.LineSegments(
            new THREE.WireframeGeometry(
              new THREE.TetrahedronGeometry(
                0.1 + (index % 4) * 0.02,
                0
              )
            ),
            new THREE.LineBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff756d
                  : 0xa8131c,
              transparent: true,
              opacity: 0.52,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        fragment.position.copy(outer)
        fragment.rotation.set(
          theta * 0.7,
          theta,
          y * 1.8
        )
        fragment.userData.phase =
          index * 0.41
        fragment.userData.baseScale =
          0.84 + (index % 3) * 0.12

        fractureArchitecture.add(fragment)
        fractureFragments.push(fragment)
      }
    }

    const fractureLines =
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(
          fractureSegments
        ),
        new THREE.LineBasicMaterial({
          color: 0xd41d25,
          transparent: true,
          opacity: 0.42,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    fractureArchitecture.add(fractureLines)
    fractureArchitecture.rotation.set(0.16, -0.2, 0.07)
    brain.add(fractureArchitecture)
    architectureLayers.push({
      group: fractureArchitecture,
      lines: fractureLines,
      fragments: fractureFragments,
    })

    /*
     * Label creation
     */
    function createLabel(
      name
    ) {
      const canvas =
        document.createElement(
          "canvas"
        )

      canvas.width = 512
      canvas.height = 128

      const ctx =
        canvas.getContext(
          "2d"
        )

      if (!ctx) {
        return null
      }

      ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
      )

      ctx.font =
        "800 44px Arial"

      ctx.textAlign =
        "center"

      ctx.textBaseline =
        "middle"

      ctx.lineWidth = 9
      ctx.strokeStyle =
        "rgba(0,0,0,.95)"

      ctx.strokeText(
        name,
        256,
        64
      )

      ctx.fillStyle =
        "rgba(255,255,255,.95)"

      ctx.fillText(
        name,
        256,
        64
      )

      const texture =
        new THREE.CanvasTexture(
          canvas
        )

      texture.colorSpace =
        THREE.SRGBColorSpace

      const sprite =
        new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            depthTest: false,
          })
        )

      sprite.scale.set(
        0.88,
        0.22,
        1
      )

      return sprite
    }

    function createAtomNode({
      radius,
      color = 0xff3030,
      isAnchor = false,
    }) {
      const node = new THREE.Group()
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(
          radius,
          isAnchor ? 20 : 16,
          isAnchor ? 16 : 12
        ),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: isAnchor ? 0.94 : 0.6,
          metalness: 0.5,
          roughness: 0.23,
          transparent: true,
          opacity: isAnchor ? 0.98 : 0.95,
        })
      )

      const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(
          radius * (isAnchor ? 1.72 : 1.5),
          14,
          10
        ),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: isAnchor ? 0.075 : 0.05,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

      core.userData.nodeRoot = node
      atmosphere.userData.nodeRoot = node
      node.add(core, atmosphere)

      const orbits = new THREE.Group()
      const orbitSpecs = isAnchor
        ? [[1.56, 0.68, 0.22, 0.42], [1.72, -0.46, 0.78, -0.3]]
        : [[1.48, 0.7, 0.2, 0.36]]

      orbitSpecs.forEach(([distance, x, y, z]) => {
        const orbit = new THREE.Mesh(
          new THREE.TorusGeometry(
            radius * distance,
            Math.max(0.008, radius * 0.055),
            6,
            28
          ),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: isAnchor ? 0.34 : 0.24,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        )

        orbit.rotation.set(x, y, z)
        orbit.userData.nodeRoot = node
        orbits.add(orbit)
      })

      node.add(orbits)
      node.userData.atomOrbits = orbits
      return node
    }

    /*
     * Public starter nodes. Personal memories arrive only from the signed-in
     * account's local vault and are never embedded in the distributed app.
     */
    const semanticData = [
      ["OPERATOR", 0.24],
      ["LOCAL AI", 0.14],
      ["KNOWLEDGE VAULT", 0.12],
      ["LOCAL HOST", 0.15],
      ["AUTOMATION", 0.12],
      ["LOCAL MODEL", 0.12],
      ["PROJECTS", 0.12],
      ["OBSIDIAN", 0.12],
      ["DEVICES", 0.11],
      ["INTEGRATIONS", 0.10],
      ["3D FABRICATION", 0.11],
      ["BROWSER", 0.09],
      ["CODE WORKSPACE", 0.09],
      ["PRIVATE NETWORK", 0.10],
      ["SECURITY", 0.10],
      ["MEMORY", 0.10],
      ["WEATHER", 0.08],
    ]

    /*
     * Spatial distribution for important nodes.
     *
     * Nodes are generated inside the full 3D volume.
     * Each new node tries to stay far from the
     * previously placed important nodes.
     */

    function hashText(value) {
      let hash = 0

      for (
        let i = 0;
        i < value.length;
        i += 1
      ) {
        hash =
          (
            (
              hash << 5
            ) -
            hash +
            value.charCodeAt(i)
          ) |
          0
      }

      return Math.abs(hash)
    }

    function seededRandom(seed) {
      let value =
        seed >>> 0

      return () => {
        value =
          (
            value * 1664525 +
            1013904223
          ) >>> 0

        return (
          value / 4294967296
        )
      }
    }

    function randomVolumePoint(
      seed,
      maxRadius = 2.60
    ) {
      const random =
        seededRandom(seed)

      const theta =
        random() *
        Math.PI *
        2

      const phi =
        Math.acos(
          1 -
          2 * random()
        )

      /*
       * Cube root keeps the points
       * distributed through the volume
       * instead of concentrating them
       * near the center.
       */
      const radial =
        Math.cbrt(
          random()
        ) *
        maxRadius

      const sinPhi =
        Math.sin(phi)

      return new THREE.Vector3(
        Math.cos(theta) *
          sinPhi *
          radial,

        Math.cos(phi) *
          radial,

        Math.sin(theta) *
          sinPhi *
          radial
      )
    }

    const reservedSemanticPositions = []

    function chooseSemanticPosition(
      name,
      index
    ) {
      /*
       * OPERATOR is the neutral neural anchor shown before local memories
       * populate the signed-in account's graph.
       */
      if (
        name === "OPERATOR"
      ) {
        const center =
          new THREE.Vector3(
            0,
            0,
            0
          )

        reservedSemanticPositions.push(
          center
        )

        return center
      }

      const seed =
        hashText(name) +
        index * 1009

      let bestPoint =
        null

      let bestDistance =
        -Infinity

      /*
       * Generate many deterministic candidates
       * and select the one that is farthest
       * from all existing important nodes.
       */
      for (
        let candidateIndex = 0;
        candidateIndex < 220;
        candidateIndex += 1
      ) {
        const candidate =
          randomVolumePoint(
            seed +
              candidateIndex *
                7919,
            2.62
          )

        let nearest =
          Infinity

        for (
          const occupied
          of reservedSemanticPositions
        ) {
          nearest =
            Math.min(
              nearest,
              candidate.distanceTo(
                occupied
              )
            )
        }

        if (
          reservedSemanticPositions.length === 0
        ) {
          nearest =
            candidate.length()
        }

        if (
          nearest >
          bestDistance
        ) {
          bestDistance =
            nearest

          bestPoint =
            candidate
        }
      }

      const result =
        bestPoint ||
        randomVolumePoint(
          seed
        )

      reservedSemanticPositions.push(
        result
      )

      return result.clone()
    }

    semanticData.forEach(
      ([name, size], index) => {
        const position =
          chooseSemanticPosition(
            name,
            index
          )

        const node = createAtomNode({
          radius: size,
          color: name === "OPERATOR" ? 0xff5148 : 0xf23a35,
          isAnchor: name === "OPERATOR",
        })

        node.position.copy(
          position
        )

        node.userData.name =
          name

        node.userData.strength =
          name === "OPERATOR"
            ? 1
            : 0.7

        node.userData.details =
          describeCoreNode({
            name,
            strength: node.userData.strength,
          })

        node.userData.phase =
          Math.random() *
          Math.PI *
          2

        brain.add(node)

        semanticNodes.push(
          node
        )

        semanticMap.set(
          name.toLowerCase(),
          node
        )

        /*
         * Only important nodes receive labels.
         */
        if (
          name === "OPERATOR" ||
          size >= 0.10
        ) {
          const label =
            createLabel(
              name
            )

          if (label) {
            label.position.copy(
              position
            )

            label.position.multiplyScalar(
              1.10
            )

            label.userData.follow =
              node

            labels.add(
              label
            )
          }
        }
      }
    )

    /*
     * Central reactor glow beneath the interactive OPERATOR anchor.
     */
    const coreGlow =
      new THREE.Mesh(
        new THREE.SphereGeometry(
          0.34,
          24,
          24
        ),
        new THREE.MeshBasicMaterial({
          color: 0xff1010,
          transparent: true,
          opacity: 0.04,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    coreGlow.position.set(
      0,
      0,
      0
    )

    brain.add(
      coreGlow
    )

    /*
     * A nested reactor makes the anchor feel like a hostile intelligence,
     * while the surrounding graph remains fully interactive.
     */
    const reactor =
      new THREE.Group()

    const reactorCore =
      new THREE.Mesh(
        new THREE.SphereGeometry(
          0.12,
          20,
          20
        ),
        new THREE.MeshBasicMaterial({
          color: 0xff4b44,
          transparent: true,
          opacity: 0.48,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    const reactorHalo =
      new THREE.LineSegments(
        new THREE.WireframeGeometry(
          new THREE.IcosahedronGeometry(
            0.34,
            2
          )
        ),
        new THREE.LineBasicMaterial({
          color: 0xff1414,
          transparent: true,
          opacity: 0.14,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    const reactorCages = [
      {
        radius: 0.48,
        rotation: [0.52, 0.18, 0.72],
        color: 0xff4239,
        opacity: 0.16,
        speed: 0.0026,
      },
    ].map((spec) => {
      const cageGeometry =
        spec.geometry === 'dodecahedron'
          ? new THREE.DodecahedronGeometry(
              spec.radius,
              0
            )
          : new THREE.OctahedronGeometry(
              spec.radius,
              1
            )

      const cage =
        new THREE.LineSegments(
          new THREE.WireframeGeometry(
            cageGeometry
          ),
          new THREE.LineBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: spec.opacity,
            blending:
              THREE.AdditiveBlending,
            depthWrite: false,
          })
        )

      cage.rotation.set(...spec.rotation)
      cage.userData.speed = spec.speed
      return cage
    })

    const reactorShardShell =
      new THREE.LineSegments(
        new THREE.WireframeGeometry(
          new THREE.DodecahedronGeometry(
            0.38,
            0
          )
        ),
        new THREE.LineBasicMaterial({
          color: 0xff837a,
          transparent: true,
          opacity: 0.12,
          blending:
            THREE.AdditiveBlending,
          depthWrite: false,
        })
      )

    const reactorBlades = Array.from(
      { length: 0 },
      (_, index) => {
        const angle =
          (Math.PI * 2 * index) / 6

        const blade =
          new THREE.Mesh(
            new THREE.TetrahedronGeometry(
              index % 2 ? 0.17 : 0.13,
              0
            ),
            new THREE.MeshBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff7067
                  : 0xce1a22,
              transparent: true,
              opacity: 0.84,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        blade.position.set(
          Math.cos(angle) * 0.64,
          Math.sin(angle) * 0.64,
          (index % 3 - 1) * 0.17
        )

        blade.rotation.set(
          angle * 0.6,
          angle,
          angle * 0.35
        )

        blade.userData.phase =
          index * 0.77

        return blade
      }
    )

    const reactorLances = Array.from(
      { length: 0 },
      (_, index) => {
        const ratio =
          (index + 0.5) / 9

        const y =
          1 - ratio * 2

        const radial =
          Math.sqrt(
            Math.max(0.06, 1 - y * y)
          )

        const angle =
          goldenAngle * index * 1.18

        const direction =
          new THREE.Vector3(
            Math.cos(angle) * radial,
            y,
            Math.sin(angle) * radial
          ).normalize()

        const lance =
          new THREE.Mesh(
            new THREE.ConeGeometry(
              0.052 + (index % 3) * 0.013,
              0.42 + (index % 4) * 0.07,
              4,
              1
            ),
            new THREE.MeshBasicMaterial({
              color:
                index % 4 === 0
                  ? 0xffa099
                  : 0xc21420,
              transparent: true,
              opacity: 0.6,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        const baseDistance =
          1.02 + (index % 4) * 0.13

        lance.position.copy(
          direction.clone().multiplyScalar(
            baseDistance
          )
        )

        lance.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          direction.clone().multiplyScalar(-1)
        )

        lance.userData.direction = direction
        lance.userData.baseDistance = baseDistance
        lance.userData.phase = index * 0.58
        return lance
      }
    )

    const reactorCrystals = Array.from(
      { length: 0 },
      (_, index) => {
        const angle =
          goldenAngle * index * 1.9

        const crystal =
          new THREE.Mesh(
            new THREE.OctahedronGeometry(
              0.055 + (index % 3) * 0.025,
              0
            ),
            new THREE.MeshBasicMaterial({
              color:
                index % 2
                  ? 0xff413b
                  : 0xffaaa3,
              transparent: true,
              opacity: 0.67,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        crystal.position.set(
          Math.cos(angle) *
            (0.38 + (index % 3) * 0.11),
          Math.sin(angle * 1.61) *
            (0.3 + (index % 2) * 0.15),
          Math.cos(angle * 0.73) *
            (0.25 + (index % 4) * 0.07)
        )

        crystal.userData.phase =
          index * 0.92
        return crystal
      }
    )

    reactor.add(reactorHalo)
    reactor.add(reactorCore)
    reactorCages.forEach((cage) => {
      reactor.add(cage)
    })
    reactor.add(reactorShardShell)
    reactorBlades.forEach((blade) => {
      reactor.add(blade)
    })
    reactorLances.forEach((lance) => {
      reactor.add(lance)
    })
    reactorCrystals.forEach((crystal) => {
      reactor.add(crystal)
    })

    reactor.scale.set(0.82, 0.82, 0.82)

    brain.add(reactor)

    const memoryLayer =
      new THREE.Group()

    brain.add(
      memoryLayer
    )

    function clearMemoryLayer() {
      dynamicSemanticNodes.splice(0).forEach(
        node => {
          const index = semanticNodes.indexOf(node)

          if (index >= 0) {
            semanticNodes.splice(index, 1)
          }
        }
      )

      while (
        memoryLayer.children.length
      ) {
        const child =
          memoryLayer.children.pop()

        child.traverse((object) => {
          if (object.geometry) {
            object.geometry.dispose()
          }

          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material]

          materials.filter(Boolean).forEach((material) => {
            if (material.map) {
              material.map.dispose()
            }

            material.dispose()
          })
        })
      }
    }

    function stablePosition(
      name,
      index
    ) {
      let hash = 0

      for (
        let i = 0;
        i < name.length;
        i += 1
      ) {
        hash =
          (
            (
              hash << 5
            ) -
            hash +
            name.charCodeAt(i)
          ) |
          0
      }

      const normalized =
        Math.abs(hash)

      const y =
        0.72 -
        (
          (
            normalized % 1000
          ) /
            999
        ) *
          1.44

      const ring =
        Math.sqrt(
          Math.max(
            0.05,
            1 - y * y
          )
        )

      const theta =
        (
          normalized *
            0.6180339887
        ) +
        index * 1.7

      return new THREE.Vector3(
        Math.cos(theta) *
          ring *
          2.92,
        y * 2.92,
        Math.sin(theta) *
          ring *
          2.92
      )
    }

    function renderMemoryGraph(
      graph
    ) {
      clearMemoryLayer()

      const nodes =
        Array.isArray(
          graph?.nodes
        )
          ? graph.nodes
          : []

      const edges =
        Array.isArray(
          graph?.edges
        )
          ? graph.edges
          : []

      const dynamicMap =
        new Map()

      nodes.forEach(
        (
          item,
          index
        ) => {
          const name =
            String(
              item?.name || ""
            ).trim()

          if (!name) {
            return
          }

          if (isHiddenGraphNode(item)) {
            return
          }

          const key =
            name.toLowerCase()

          const permanent =
            semanticMap.get(
              key
            )

          if (permanent) {
            dynamicMap.set(
              String(
                item.id
              ),
              permanent
            )

            const strength =
              Math.max(
                0.25,
                Math.min(
                  1,
                  Number(
                    item.strength ??
                      0.5
                  )
                )
              )

            permanent.userData
              .memoryStrength =
              strength

            return
          }

          const strength =
            Math.max(
              0.25,
              Math.min(
                1,
                Number(
                  item.strength ??
                    0.5
                )
              )
            )

          const position =
            stablePosition(
              name,
              index
            )

          const node = createAtomNode({
            radius: 0.07 + strength * 0.1,
            color: 0xff4038,
          })

          node.position.copy(
            position
          )

          node.userData.name =
            name

          node.userData.strength =
            strength

          node.userData.details =
            describeCoreNode({
              id: String(item.id || `memory-${index}`),
              name,
              relation: item.relation || item.predicate || 'memory link',
              strength,
              type: item.type || 'MEMORY FRAGMENT',
              source: item.source || 'NEURAL MEMORY',
              description: item.description || item.object || `Memory fragment for ${name}.`,
              path: item.path || '',
              linkCount: item.linkCount || 0,
            })

          node.userData.phase =
            Math.random() *
            Math.PI *
            2

          memoryLayer.add(
            node
          )

          semanticNodes.push(node)
          dynamicSemanticNodes.push(node)

          dynamicMap.set(
            String(
              item.id
            ),
            node
          )

          const label =
            createLabel(
              name
            )

          if (label) {
            label.position.copy(
              position
            )

            label.position.multiplyScalar(
              1.12
            )

            label.userData.follow =
              node

            memoryLayer.add(
              label
            )
          }
        }
      )

      edges.forEach(
        (edge) => {
          const source =
            dynamicMap.get(
              String(
                edge?.source
              )
            )

          const target =
            dynamicMap.get(
              String(
                edge?.target
              )
            )

          if (
            !source ||
            !target
          ) {
            return
          }

          const geometry =
            new THREE.BufferGeometry().setFromPoints(
              [
                source.position,
                target.position,
              ]
            )

          const line =
            new THREE.Line(
              geometry,
              new THREE.LineBasicMaterial({
                color: 0xff2020,
                transparent: true,
                opacity: 0.64,
              })
            )

          memoryLayer.add(
            line
          )
        }
      )
    }

    async function loadMemoryGraph() {
      try {
        const [
          memoryResponse,
          obsidianResponse,
        ] = await Promise.all([
          fetch(
            `${BACKEND}/api/memory/graph`
          ),
          fetch(
            `${BACKEND}/api/obsidian/graph`
          ),
        ])

        let memoryGraph = {
          nodes: [],
          edges: [],
        }

        let obsidianGraph = {
          nodes: [],
          edges: [],
        }

        if (
          memoryResponse.ok
        ) {
          memoryGraph =
            await memoryResponse.json()
        }

        if (
          obsidianResponse.ok
        ) {
          obsidianGraph =
            await obsidianResponse.json()
        }

        const nodesById =
          new Map()

        const addNode = (
          node
        ) => {
          if (!node?.id) {
            return
          }

          nodesById.set(
            String(node.id),
            node
          )
        }

        ;(
          Array.isArray(
            memoryGraph?.nodes
          )
            ? memoryGraph.nodes
            : []
        ).forEach(
          addNode
        )

        ;(
          Array.isArray(
            obsidianGraph?.nodes
          )
            ? obsidianGraph.nodes
            : []
        ).forEach(
          addNode
        )

        const edges = [
          ...(
            Array.isArray(
              memoryGraph?.edges
            )
              ? memoryGraph.edges
              : []
          ),
          ...(
            Array.isArray(
              obsidianGraph?.edges
            )
              ? obsidianGraph.edges
              : []
          ),
        ]

        renderMemoryGraph({
          nodes: [
            ...nodesById.values(),
          ],
          edges,
        })
      } catch {
        // Backend temporarily unavailable.
      }
    }


    loadMemoryGraph()

    const memoryTimer =
      window.setInterval(
        loadMemoryGraph,
        5000
      )

    /*
     * Moving signal particles
     */
    const signals = []

    for (
      let i = 0;
      i < 26;
      i += 1
    ) {
      const signal =
        new THREE.Mesh(
          new THREE.SphereGeometry(
            0.028,
            6,
            6
          ),
          new THREE.MeshBasicMaterial({
            color: 0xff3030,
            transparent: true,
            opacity: 0.86,
          })
        )

      signal.userData.source =
        Math.floor(
          Math.random() *
            positions.length
        )

      signal.userData.target =
        Math.floor(
          Math.random() *
            positions.length
        )

      signal.userData.progress =
        Math.random()

      signal.userData.speed =
        0.002 +
        Math.random() *
          0.006

      brain.add(
        signal
      )

      signals.push(
        signal
      )
    }

    /*
     * Dedicated command routes converge on important entities. They give the
     * network visible intent: bright packets travel on broken curves from the
     * kernel rather than drifting on circular paths.
     */
    const commandTraces = []
    const traceTargets =
      semanticNodes.filter(
        node => node.userData.name !== 'OPERATOR'
      )

    traceTargets.slice(0, 8).forEach(
      (targetNode, index) => {
        const target =
          targetNode.position.clone()

        const entry =
          target.clone()
            .normalize()
            .multiplyScalar(1.24)

        const phase =
          index * 0.61

        const offset =
          new THREE.Vector3(
            Math.sin(phase * 2.1) * 0.46,
            Math.cos(phase * 1.4) * 0.34,
            Math.cos(phase * 1.9) * 0.42
          )

        const curve =
          new THREE.CatmullRomCurve3(
            [
              entry,
              target.clone()
                .multiplyScalar(0.48)
                .add(offset.clone().multiplyScalar(0.46)),
              target.clone()
                .multiplyScalar(0.72)
                .add(offset),
              target,
            ],
            false,
            'centripetal'
          )

        const traceLine =
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(
              curve.getPoints(26)
            ),
            new THREE.LineBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff9a92
                  : 0xb51620,
              transparent: true,
              opacity: 0.12,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        const packet =
          new THREE.Mesh(
            new THREE.OctahedronGeometry(
              index % 2 ? 0.038 : 0.052,
              0
            ),
            new THREE.MeshBasicMaterial({
              color: 0xff8f87,
              transparent: true,
              opacity: 0.96,
              blending:
                THREE.AdditiveBlending,
              depthWrite: false,
            })
          )

        packet.userData.phase = phase
        packet.userData.speed =
          0.1 + (index % 4) * 0.019

        brain.add(traceLine)
        brain.add(packet)

        commandTraces.push({
          curve,
          line: traceLine,
          packet,
          phase,
        })
      }
    )

    /*
     * Node selection
     */
    const raycaster =
      new THREE.Raycaster()

    const pointer =
      new THREE.Vector2()

    function onPointerDown(
      event
    ) {
      const rect =
        renderer.domElement.getBoundingClientRect()

      pointer.x =
        (
          (
            event.clientX -
              rect.left
          ) /
            rect.width
        ) *
          2 -
        1

      pointer.y =
        -(
          (
            event.clientY -
              rect.top
          ) /
            rect.height
        ) *
          2 +
        1

      raycaster.setFromCamera(
        pointer,
        camera
      )

      const hits =
        raycaster.intersectObjects(
          semanticNodes,
          true
        )

      if (
        hits.length &&
        onSelect
      ) {
        const node =
          hits[0].object.userData.nodeRoot ||
          hits[0].object

        onSelect(
          node.userData.details ||
          describeCoreNode({
            name: node.userData.name,
            strength: node.userData.strength ?? 0.5,
          })
        )
      }
    }

    renderer.domElement.addEventListener(
      "pointerdown",
      onPointerDown
    )

    const clock =
      new THREE.Clock()

    function animate() {
      animationRef.current =
        requestAnimationFrame(
          animate
        )

      const time =
        clock.getElapsedTime()

      controls.update()

      /*
       * Rotate the whole neural construct as one oblique body. Individual
       * layers still retain their own small motions, so the surface feels
       * alive without losing the slow global orbit.
       */
      brain.rotation.y += 0.00034
      brain.rotation.x += 0.00011
      brain.rotation.z += 0.00007

      cortexLayers.forEach(
        (layer, index) => {
          layer.rotation.y +=
            0.0008 + index * 0.00025

          layer.rotation.x =
            Math.sin(
              time * 0.12 + index
            ) *
            0.08
        }
      )

      orbitalLayers.forEach(
        (ring, index) => {
          ring.rotation.z +=
            ring.userData.speed

          ring.rotation.x +=
            ring.userData.speed *
            (index % 2 === 0 ? 0.35 : -0.22)
        }
      )

      sphericalLayers.forEach((layer, index) => {
        const speed = layer.userData.speed || 0.00018

        layer.rotation.y += speed
        layer.rotation.x += speed * (index % 2 ? -0.54 : 0.38)

        if (layer.isPoints) {
          layer.material.opacity =
            0.58 + Math.sin(time * 1.1) * 0.18
        }
      })

      architectureLayers.forEach(
        (layer, index) => {
          layer.group.rotation.y +=
            0.00048 + index * 0.00017
          layer.group.rotation.x =
            Math.sin(time * 0.22 + index) *
            0.1

          layer.group.scale.setScalar(
            1 + Math.sin(time * 0.7) * 0.018
          )

          layer.lines.material.opacity =
            0.2 +
            Math.sin(time * 1.3 + index) * 0.1

          layer.fragments.forEach(
            (fragment, fragmentIndex) => {
              const phase =
                fragment.userData.phase || 0
              const baseScale =
                fragment.userData.baseScale || 1

              fragment.rotation.x +=
                0.006 + fragmentIndex * 0.0002
              fragment.rotation.z -=
                0.004 + (fragmentIndex % 3) * 0.0005

              fragment.scale.setScalar(
                baseScale +
                  Math.sin(time * 1.7 + phase) *
                    0.18
              )
            }
          )
        }
      )

      reactor.rotation.y += 0.0045
      reactor.rotation.z =
        Math.sin(time * 0.8) * 0.09

      const reactorPulse =
        1 +
        Math.sin(time * 2.7) * 0.12

      reactorCore.scale.setScalar(
        reactorPulse
      )

      reactorHalo.scale.setScalar(
        1.15 +
          Math.sin(time * 1.8) * 0.16
      )

      reactorCages.forEach(
        (cage, index) => {
          cage.rotation.y +=
            cage.userData.speed
          cage.rotation.z +=
            cage.userData.speed *
            (index ? -0.55 : 0.4)
        }
      )

      reactorShardShell.rotation.x -= 0.005
      reactorShardShell.rotation.y += 0.011
      reactorShardShell.rotation.z =
        Math.sin(time * 0.9) * 0.24

      reactorBlades.forEach(
        (blade, index) => {
          const phase = blade.userData.phase || 0

          blade.rotation.x +=
            0.012 + index * 0.00045
          blade.rotation.z -=
            0.008 + (index % 2) * 0.002

          blade.scale.setScalar(
            0.88 +
              Math.sin(
                time * 2.4 + phase
              ) *
                0.24
          )
        }
      )

      reactorLances.forEach(
        (lance) => {
          const phase = lance.userData.phase || 0
          const baseDistance =
            lance.userData.baseDistance || 1
          const direction =
            lance.userData.direction ||
            new THREE.Vector3(0, 1, 0)

          lance.position.copy(
            direction.clone().multiplyScalar(
              baseDistance +
                Math.sin(time * 2.1 + phase) *
                  0.16
            )
          )

          lance.scale.y =
            0.8 +
            Math.sin(time * 2.8 + phase) * 0.27
        }
      )

      reactorCrystals.forEach(
        (crystal, index) => {
          const phase = crystal.userData.phase || 0

          crystal.rotation.x +=
            0.014 + index * 0.0003
          crystal.rotation.y -=
            0.009 + (index % 3) * 0.0007
          crystal.scale.setScalar(
            0.78 +
              Math.sin(time * 3.2 + phase) *
                0.28
          )
        }
      )

      microNodes.forEach(
        (
          node,
          index
        ) => {
          node.scale.setScalar(
            1 +
              Math.sin(
                time * 2.1 +
                  node.userData.phase +
                  index * 0.02
              ) *
                0.08
          )

          node.material.opacity =
            Math.max(
              0.22,
              Math.min(
                0.94,
                node.userData
                    .baseOpacity +
                  Math.sin(
                    time * 1.6 +
                      node.userData.phase
                  ) *
                    0.08
              )
            )
        }
      )

      semanticNodes.forEach(
        (
          node,
          index
        ) => {
          const strength =
            Number(
              node.userData
                .memoryStrength ??
                node.userData
                  .strength ??
                0.5
            )

          const base =
            node.userData.name ===
            "OPERATOR"
              ? 1.02
              : 0.86 +
                strength *
                  0.35

          node.scale.setScalar(
            base +
              Math.sin(
                time * 2.3 +
                  index * 0.32
              ) *
                0.045
          )

          const atomOrbits =
            node.userData.atomOrbits

          if (atomOrbits) {
            atomOrbits.rotation.y +=
              0.005 + index * 0.00012
            atomOrbits.rotation.x =
              Math.sin(time * 0.9 + index) * 0.16
          }
        }
      )

      signals.forEach(
        (
          signal
        ) => {
          const source =
            positions[
              signal.userData.source
            ]

          const target =
            positions[
              signal.userData.target
            ]

          signal.userData.progress +=
            signal.userData.speed

          if (
            signal.userData.progress >
            1
          ) {
            signal.userData.progress =
              0

            signal.userData.source =
              Math.floor(
                Math.random() *
                  positions.length
              )

            signal.userData.target =
              Math.floor(
                Math.random() *
                  positions.length
              )
          }

          signal.position.lerpVectors(
            source,
            target,
            signal.userData
              .progress
          )
        }
      )

      commandTraces.forEach(
        (trace, index) => {
          const speed =
            trace.packet.userData.speed || 0.1

          const progress =
            (time * speed + trace.phase) % 1

          trace.packet.position.copy(
            trace.curve.getPointAt(progress)
          )

          trace.packet.rotation.x +=
            0.08 + index * 0.004
          trace.packet.rotation.y +=
            0.11 + (index % 3) * 0.018

          trace.packet.scale.setScalar(
            0.72 +
              Math.sin(time * 4.4 + trace.phase) *
                0.32
          )

          trace.line.material.opacity =
            0.11 +
            Math.sin(time * 1.8 + trace.phase) *
              0.08
        }
      )

      brain.updateMatrixWorld()

      labels.children.forEach(
        (
          label
        ) => {
          const follow =
            label.userData?.follow

          if (!follow) {
            return
          }

          follow.getWorldPosition(
            labelWorldPosition
          )

          label.position.copy(
            labelWorldPosition
          )

          label.position.multiplyScalar(
            1.10
          )
        }
      )

      memoryLayer.children.forEach(
        (
          object
        ) => {
          if (
            object.isSprite
          ) {
            const follow =
              object.userData?.follow

            if (follow) {
              object.position.copy(
                follow.position
              )

              object.position.multiplyScalar(
                1.12
              )
            }
          }
        }
      )

      renderer.render(
        scene,
        camera
      )
    }

    animate()

    function onResize() {
      const width =
        Math.max(
          1,
          mount.clientWidth
        )

      const height =
        Math.max(
          1,
          mount.clientHeight
        )

      camera.aspect =
        width / height

      camera.updateProjectionMatrix()

      renderer.setSize(
        width,
        height
      )
    }

    window.addEventListener(
      "resize",
      onResize
    )

    const resizeObserver =
      new ResizeObserver(
        onResize
      )

    resizeObserver.observe(
      mount
    )

    onResize()

    return () => {
      cancelAnimationFrame(
        animationRef.current
      )

      clearInterval(
        memoryTimer
      )

      window.removeEventListener(
        "resize",
        onResize
      )

      renderer.domElement.removeEventListener(
        "pointerdown",
        onPointerDown
      )

      resizeObserver.disconnect()

      controls.dispose()

      scene.traverse(
        (object) => {
          if (
            object.geometry
          ) {
            object.geometry.dispose()
          }

          if (
            object.material
          ) {
            if (
              Array.isArray(
                object.material
              )
            ) {
              object.material.forEach(
                (
                  material
                ) => {
                  if (
                    material.map
                  ) {
                    material.map.dispose()
                  }

                  material.dispose()
                }
              )
            } else {
              if (
                object.material.map
              ) {
                object.material.map.dispose()
              }

              object.material.dispose()
            }
          }
        }
      )

      renderer.dispose()

      if (
        renderer.domElement.parentNode ===
        mount
      ) {
        mount.removeChild(
          renderer.domElement
        )
      }
    }
  }, [onSelect])

  return (
    <div
      ref={mountRef}
      className="brain-renderer"
      aria-label="ULTRON neural core"
    />
  )
}

let currentFishAudio = null

async function speakWithFish(text) {

  const clean =
    String(text || "").trim()

  if (!clean) {
    return
  }

  try {

    if (currentFishAudio) {
      try {
        currentFishAudio.pause()
        currentFishAudio.currentTime = 0
      } catch {
        // Ignore cleanup errors.
      }
    }

    const url =
      `${BACKEND}/api/tts/stream?text=${
        encodeURIComponent(clean)
      }`

    const audio =
      new Audio(url)

    audio.preload = "auto"

    currentFishAudio = audio

    audio.addEventListener(
      "ended",
      () => {
        if (currentFishAudio === audio) {
          currentFishAudio = null
        }
      },
      { once: true }
    )

    audio.addEventListener(
      "error",
      () => {
        console.warn(
          "Fish Audio playback failed."
        )

        if (currentFishAudio === audio) {
          currentFishAudio = null
        }
      },
      { once: true }
    )

    await audio.play()

  } catch (error) {

    console.warn(
      "Fish TTS unavailable:",
      error
    )
  }
}


function NavIcon({ name }) {
  const iconProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.7',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  if (name === 'memory') {
    return (
      <svg {...iconProps}>
        <path d="M5 7.5 12 4l7 3.5-7 3.5-7-3.5Z" />
        <path d="M5 12l7 3.5 7-3.5" />
        <path d="M5 16.5 12 20l7-3.5" />
      </svg>
    )
  }

  if (name === 'devices') {
    return (
      <svg {...iconProps}>
        <rect x="4" y="4" width="16" height="11" rx="2" />
        <path d="M9 20h6M12 15v5" />
        <path d="M8 8h.01M12 8h.01M16 8h.01" />
      </svg>
    )
  }

  if (name === 'settings') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56v.1h-3v-.1a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.04 15 1.7 1.7 0 0 0 5.5 13.96h-.1v-3h.1A1.7 1.7 0 0 0 7.04 9.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.04-1.56v-.1h3v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.04h.1v3h-.1A1.7 1.7 0 0 0 19.4 15Z" />
      </svg>
    )
  }

  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="7" />
      <path d="M9.4 12h5.2M12 9.4v5.2" />
      <path d="M5 5l2.1 2.1M19 5l-2.1 2.1" />
    </svg>
  )
}


function formatChatTime(value) {
  const date = new Date(value || Date.now())

  return date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function MemoryProposalCard({ proposal, onCommit, onDiscard }) {
  const status = proposal?.status || 'pending'
  const items = Array.isArray(proposal?.items) ? proposal.items : []
  const isSaving = status === 'saving'
  const isDone = status === 'saved' || status === 'discarded'

  return (
    <section className={`agent-action-card memory-proposal ${status}`}>
      <header>
        <span>MEMORY STAGING AREA</span>
        <strong>{status === 'saved' ? 'CORE UPDATED' : status === 'discarded' ? 'DISCARDED' : 'CONFIRM REQUIRED'}</strong>
      </header>
      <div className="memory-proposal-list">
        {items.map((item, index) => (
          <div key={`${item.subject}-${item.predicate}-${index}`}>
            <span>{item.subject}</span>
            <i>{item.predicate}</i>
            <strong>{item.object}</strong>
          </div>
        ))}
      </div>
      {proposal?.error && <p className="agent-action-error">{proposal.error}</p>}
      {!isDone && (
        <div className="agent-action-controls">
          <button
            type="button"
            className="agent-action-primary"
            onClick={() => onCommit(proposal)}
            disabled={isSaving}
          >
            {isSaving ? 'SYNCING…' : 'ADD TO NEURAL CORE'}
          </button>
          <button
            type="button"
            className="agent-action-secondary"
            onClick={() => onDiscard(proposal)}
            disabled={isSaving}
          >
            DISCARD
          </button>
        </div>
      )}
    </section>
  )
}

function ObsidianArchiveCard({ archive }) {
  const ok = Boolean(archive?.ok)
  const saved = Number(archive?.saved || 0)

  return (
    <section className={`agent-action-card obsidian-archive ${ok ? 'saved' : 'failed'}`}>
      <header>
        <span>OBSIDIAN VAULT</span>
        <strong>{ok ? 'ARCHIVED' : 'ARCHIVE FAILED'}</strong>
      </header>
      {ok ? (
        <div className="obsidian-archive-details">
          <strong>{archive.title || 'NEURAL CORE ENTRY'}</strong>
          <span>{archive.path || 'ULTRON/Neural Core.md'}</span>
          <em>{saved ? `${saved} CORE LINK${saved === 1 ? '' : 'S'} UPDATED` : 'VAULT ENTRY SAVED'}</em>
        </div>
      ) : (
        <p className="agent-action-error">
          {archive?.error || 'Connect an Obsidian vault in Settings first.'}
        </p>
      )}
    </section>
  )
}

function EmailDraftCard({ draft, onSend }) {
  const status = draft?.status || 'pending'
  const canSend = status === 'pending' || status === 'failed'

  return (
    <section className={`agent-action-card email-draft ${status}`}>
      <header>
        <span>OUTBOUND TRANSMISSION</span>
        <strong>{status === 'sent' ? 'SENT' : status === 'sending' ? 'TRANSMITTING' : 'REVIEW REQUIRED'}</strong>
      </header>
      <dl className="email-draft-details">
        <div><dt>TO</dt><dd>{(draft?.to || []).join(', ')}</dd></div>
        <div><dt>SUBJECT</dt><dd>{draft?.subject || '(no subject)'}</dd></div>
        <div><dt>MESSAGE</dt><dd>{draft?.body || '(no message)'}</dd></div>
      </dl>
      {draft?.error && <p className="agent-action-error">{draft.error}</p>}
      {canSend && (
        <div className="agent-action-controls">
          <button
            type="button"
            className="agent-action-primary"
            onClick={() => onSend(draft)}
            disabled={status === 'sending'}
          >
            {status === 'sending' ? 'TRANSMITTING…' : 'SEND NOW'}
          </button>
        </div>
      )}
    </section>
  )
}

function normaliseVoiceText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function getVoiceRecognitionConstructor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function useUltronVoice({ onCommand, onWake }) {
  const [supported, setSupported] = useState(() => Boolean(getVoiceRecognitionConstructor()))
  const [phase, setPhase] = useState('off')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const recognitionRef = useRef(null)
  const shouldRunRef = useRef(false)
  const phaseRef = useRef('off')
  const draftRef = useRef('')
  const silenceTimerRef = useRef(0)
  const restartTimerRef = useRef(0)
  const dispatchingRef = useRef(false)
  const onCommandRef = useRef(onCommand)
  const onWakeRef = useRef(onWake)

  useEffect(() => {
    onCommandRef.current = onCommand
    onWakeRef.current = onWake
  }, [onCommand, onWake])

  function setVoicePhase(next) {
    phaseRef.current = next
    setPhase(next)
  }

  function clearSilenceTimer() {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = 0
    }
  }

  function clearRestartTimer() {
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current)
      restartTimerRef.current = 0
    }
  }

  function startRecognition() {
    const Recognition = getVoiceRecognitionConstructor()

    if (!Recognition || !shouldRunRef.current || dispatchingRef.current) {
      return
    }

    setSupported(true)

    if (!recognitionRef.current) {
      const recognition = new Recognition()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'it-IT'
      recognition.maxAlternatives = 1

      recognition.onresult = event => {
        let interim = ''

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const phrase = String(result?.[0]?.transcript || '').trim()

          if (!phrase) continue

          if (!result.isFinal) {
            interim = phrase
            continue
          }

          ingestFinalPhrase(phrase)
        }

        if (interim) {
          clearSilenceTimer()
          setLiveTranscript(interim)
        }
      }

      recognition.onspeechstart = () => {
        clearSilenceTimer()
      }

      recognition.onspeechend = () => {
        if (phaseRef.current === 'listening' && draftRef.current) {
          scheduleDispatch()
        }
      }

      recognition.onerror = event => {
        const code = event?.error || 'voice-error'

        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(code)) {
          shouldRunRef.current = false
          clearSilenceTimer()
          setVoicePhase('error')
          setError(code === 'not-allowed'
            ? 'Microphone access was not granted.'
            : 'Voice channel is unavailable.')
          return
        }

        if (code !== 'aborted' && code !== 'no-speech') {
          setError('Voice channel interrupted. Retrying…')
        }
      }

      recognition.onend = () => {
        if (!shouldRunRef.current || dispatchingRef.current || phaseRef.current === 'error') {
          return
        }

        clearRestartTimer()
        restartTimerRef.current = window.setTimeout(() => {
          startRecognition()
        }, 260)
      }

      recognitionRef.current = recognition
    }

    try {
      recognitionRef.current.start()
    } catch (startError) {
      if (startError?.name !== 'InvalidStateError') {
        setError('Unable to start the voice channel.')
      }
    }
  }

  function appendFragment(fragment) {
    const clean = String(fragment || '').replace(/\s+/g, ' ').trim()
    if (!clean) return

    const next = [draftRef.current, clean].filter(Boolean).join(' ').trim()
    draftRef.current = next
    setDraft(next)
    setLiveTranscript('')
    setVoicePhase('listening')
    scheduleDispatch()
  }

  function scheduleDispatch() {
    clearSilenceTimer()

    if (phaseRef.current !== 'listening' || !draftRef.current) return

    silenceTimerRef.current = window.setTimeout(async () => {
      const command = draftRef.current.trim()

      if (!command || phaseRef.current !== 'listening' || dispatchingRef.current) return

      dispatchingRef.current = true
      setVoicePhase('sending')
      setLiveTranscript('')

      try {
        if (recognitionRef.current) {
          recognitionRef.current.abort()
        }
      } catch {}

      try {
        await onCommandRef.current?.(command)
        draftRef.current = ''
        setDraft('')
        setError('')
      } finally {
        dispatchingRef.current = false

        if (shouldRunRef.current) {
          setVoicePhase('armed')
          restartTimerRef.current = window.setTimeout(startRecognition, 360)
        } else {
          setVoicePhase('off')
        }
      }
    }, 5000)
  }

  function ingestFinalPhrase(phrase) {
    const original = String(phrase || '').replace(/\s+/g, ' ').trim()
    const normalized = normaliseVoiceText(original).toLowerCase()

    if (!original || !shouldRunRef.current) return

    clearSilenceTimer()
    setLiveTranscript(original)

    const waitingForCommand = phaseRef.current === 'holding' || phaseRef.current === 'listening'
    const hasWakeWord = /\bultron\b/.test(normalized)
    const holdMatch = normalized.match(/\bultron\s+aspetta\b/)

    if (!waitingForCommand) {
      if (!hasWakeWord) return

      const commandAfterWake = original
        .replace(/^.*?\bultron\b\s*/i, '')
        .replace(/^aspetta\b[\s,:;.!-]*/i, '')
        .trim()

      if (holdMatch || !commandAfterWake) {
        setVoicePhase('holding')
        setLiveTranscript('')
        onWakeRef.current?.()
        return
      }

      appendFragment(commandAfterWake)
      return
    }

    const fragment = hasWakeWord
      ? original.replace(/^.*?\bultron\b\s*/i, '').trim()
      : original

    if (normaliseVoiceText(fragment).toLowerCase() === 'aspetta') {
      setVoicePhase('holding')
      onWakeRef.current?.()
      return
    }

    appendFragment(fragment)
  }

  function start() {
    const Recognition = getVoiceRecognitionConstructor()

    if (!Recognition) {
      setSupported(false)
      setVoicePhase('error')
      setError('Voice input is not available in this runtime.')
      return
    }

    shouldRunRef.current = true
    dispatchingRef.current = false
    draftRef.current = ''
    setDraft('')
    setLiveTranscript('')
    setError('')
    setVoicePhase('armed')
    startRecognition()
  }

  function stop() {
    shouldRunRef.current = false
    dispatchingRef.current = false
    clearSilenceTimer()
    clearRestartTimer()
    draftRef.current = ''
    setDraft('')
    setLiveTranscript('')
    setError('')
    setVoicePhase('off')

    try {
      recognitionRef.current?.abort()
    } catch {}
  }

  useEffect(() => {
    return () => {
      shouldRunRef.current = false
      clearSilenceTimer()
      clearRestartTimer()

      if (recognitionRef.current) {
        recognitionRef.current.onresult = null
        recognitionRef.current.onend = null
        recognitionRef.current.onerror = null
        try {
          recognitionRef.current.abort()
        } catch {}
      }
    }
  }, [])

  return {
    supported,
    phase,
    liveTranscript,
    draft,
    error,
    start,
    stop,
  }
}

function AgentChat({
  messages,
  input,
  setInput,
  sending,
  onSend,
  onCommitMemory,
  onDiscardMemory,
  onSendEmail,
  obsidianArmed,
  onToggleObsidian,
  voice,
}) {
  function submit() {
    const value = input.trim()

    if (!value || sending) {
      return
    }

    onSend(value, {
      archiveToObsidian: obsidianArmed,
    })
  }

  function handleKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="agent-chat">
      <div className="agent-chat-head">
        <div className="agent-identity">
          <span>PRIVATE CHANNEL // 01</span>
          <strong>AGENT CONSOLE</strong>
        </div>
        <button
          type="button"
          className={`agent-channel-state agent-vault-toggle ${obsidianArmed ? 'armed' : ''}`}
          onClick={onToggleObsidian}
          disabled={sending}
          aria-pressed={obsidianArmed}
          title="Archive the next command in the connected Obsidian vault"
        >
          <i />
          <em>{obsidianArmed ? 'VAULT ARMED' : 'VAULT'}</em>
        </button>
      </div>

      <div className="agent-messages">
        {messages.map((message, index) => (
          <div
            key={message.id || `${message.role}-${index}`}
            className={`agent-message ${message.role}`}
          >
            <div className="agent-message-meta">
              <span className="agent-message-role">
                {message.role === "user"
                  ? "YOU"
                  : "ULTRON"}
              </span>
              <time>{formatChatTime(message.createdAt)}</time>
            </div>

            <div className="agent-message-text">
              {message.text}
            </div>

            {message.memoryProposal && (
              <MemoryProposalCard
                proposal={message.memoryProposal}
                onCommit={proposal => onCommitMemory(message.id, proposal)}
                onDiscard={proposal => onDiscardMemory(message.id, proposal)}
              />
            )}

            {message.emailDraft && (
              <EmailDraftCard
                draft={message.emailDraft}
                onSend={draft => onSendEmail(message.id, draft)}
              />
            )}

            {message.obsidianArchive && (
              <ObsidianArchiveCard
                archive={message.obsidianArchive}
              />
            )}
          </div>
        ))}

        {sending && (
          <div className="agent-message assistant">
            <span className="agent-message-role">
              ULTRON
            </span>

            <div className="agent-thinking">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      {(voice.liveTranscript || voice.draft || voice.error) && (
        <div className={`agent-voice-readout ${voice.phase === 'error' ? 'error' : ''}`}>
          <span>{voice.error ? 'VOICE LINK // ERROR' : `VOICE LINK // ${voice.phase.toUpperCase()}`}</span>
          <strong>{voice.error || voice.liveTranscript || voice.draft}</strong>
        </div>
      )}

      <div className="agent-input-wrap">
        <textarea
          value={input}
          onChange={(event) =>
            setInput(event.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder="Issue command…"
          rows={1}
          disabled={sending}
        />

        <button
          type="button"
          className={`agent-voice ${voice.phase !== 'off' ? 'active' : ''}`}
          onClick={voice.phase === 'off' || voice.phase === 'error' ? voice.start : voice.stop}
          disabled={!voice.supported && voice.phase === 'off'}
          title={voice.supported ? 'Arm ULTRON voice command' : 'Voice input unavailable'}
          aria-label={voice.supported ? 'Arm ULTRON voice command' : 'Voice input unavailable'}
        >
          <span>◉</span>
        </button>
      </div>

      <div className="agent-hint">
        {obsidianArmed
          ? 'VAULT ARMED // ENTER COMMITS THIS COMMAND TO OBSIDIAN'
          : voice.supported
            ? (voice.phase === 'off' ? 'ENTER // EXECUTE · MIC TO ADDRESS ULTRON' : `VOICE // ${voice.phase.toUpperCase()} · 5S SILENCE TO EXECUTE`)
            : 'ENTER // EXECUTE · VOICE UNAVAILABLE'}
      </div>
    </div>
  )
}


function SystemCard({
  label,
  value,
  sub = "",
  progress,
  values = [],
}) {
  const points = Array.isArray(values)
    ? values
        .filter(
          item =>
            typeof item === "number" &&
            Number.isFinite(item)
        )
    : []

  const normalized =
    points.length > 0
      ? points
      : [0]

  const min = Math.min(...normalized)
  const max = Math.max(...normalized)
  const range =
    max - min === 0
      ? 1
      : max - min

  const width = 180
  const height = 42
  const pad = 3

  const polyline = normalized
    .map((point, index) => {
      const x =
        normalized.length === 1
          ? width / 2
          : pad +
            (index /
              (normalized.length - 1)) *
              (width - pad * 2)

      const y =
        height -
        pad -
        ((point - min) / range) *
          (height - pad * 2)

      return `${x},${y}`
    })
    .join(" ")

  const safeProgress =
    typeof progress === "number" &&
    Number.isFinite(progress)
      ? Math.max(
          0,
          Math.min(100, progress)
        )
      : null

  return (
    <section className="ultron-metric-card">
      <div className="ultron-metric-card-top">
        <div>
          <div className="ultron-metric-card-label">
            {label}
          </div>

          {sub && (
            <div className="ultron-metric-card-sub">
              {sub}
            </div>
          )}
        </div>

        <div className="ultron-metric-card-value">
          {value}
        </div>
      </div>

      {safeProgress !== null && (
        <div className="ultron-metric-card-progress">
          <div
            className="ultron-metric-card-progress-fill"
            style={{
              width:
                `${safeProgress}%`,
            }}
          />
        </div>
      )}

      {points.length > 0 && (
        <svg
          className="ultron-metric-card-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient
              id={`system-gradient-${label}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="#ff2727"
                stopOpacity=".28"
              />
              <stop
                offset="100%"
                stopColor="#ff2727"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          <polyline
            points={polyline}
            fill="none"
            stroke="#ff2727"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />

          <polyline
            points={`0,${height} ${polyline} ${width},${height}`}
            fill={`url(#system-gradient-${label})`}
            stroke="none"
          />
        </svg>
      )}

      {!points.length &&
        safeProgress === null && (
          <div className="ultron-metric-card-empty">
            NO SENSOR DATA
          </div>
        )}
    </section>
  )
}


function App({ user = null, onLogout = () => {} }) {
  const accountScope = String(
    user?.id || user?.email || 'local-operator'
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')

  const preferencesStorageKey = `ultron-preferences:${accountScope}`
  const weatherStorageKey = `ultron-weather:${accountScope}`
  const accountName = String(
    user?.display_name || user?.displayName || user?.email || 'LOCAL OPERATOR'
  )

  const [activePage, setActivePage] =
    useState('AGENT')

  const [onboardingOpen, setOnboardingOpen] =
    useState(() => shouldShowOnboarding(accountScope))

  const [selected, setSelected] =
    useState(() => describeCoreNode(CORE_NODES[0]))

  const [system, setSystem] =
    useState(null)

  const [history, setHistory] =
    useState({
      cpu: [],
      ram: [],
      download: [],
      upload: [],
    })

  const [time, setTime] =
    useState('')

  const [date, setDate] =
    useState('')

  const [weather, setWeather] =
    useState(null)

  const [agentMessages, setAgentMessages] =
    useState([
      {
        id: 'ultron-bootstrap',
        role: "assistant",
        text: "ULTRON online. I'm listening.",
        speak: false,
        createdAt: INITIAL_CHAT_TIMESTAMP,
      },
    ])

  const agentMessagesRef = useRef(agentMessages)
  const agentSendingRef = useRef(false)

  const [agentInput, setAgentInput] =
    useState("")

  const [agentSending, setAgentSending] =
    useState(false)

  const [obsidianArmed, setObsidianArmed] =
    useState(false)

  const [printerStatus, setPrinterStatus] =
    useState({
      connected: false,
      status: 'NOT CONNECTED',
      port: null,
      progress: null,
    })

  const [preferences, setPreferences] =
    useState(() => loadPreferences(preferencesStorageKey))

  const [backendOnline, setBackendOnline] =
    useState(false)

  const [isRefreshing, setIsRefreshing] =
    useState(false)


  const [obsidianPath, setObsidianPath] =
    useState('')

  const [obsidianStatus, setObsidianStatus] =
    useState({
      connected: false,
      markdown_count: 0,
    })

  const [obsidianGraph, setObsidianGraph] =
    useState({
      nodes: [],
      edges: [],
    })

  const [weatherConfig, setWeatherConfig] =
    useState(() => loadWeatherConfig(weatherStorageKey))

  useEffect(() => {
    agentMessagesRef.current = agentMessages
  }, [agentMessages])

  useEffect(() => {
    localStorage.setItem(
      preferencesStorageKey,
      JSON.stringify(preferences)
    )

    document.documentElement.style.setProperty(
      '--ultron-ui-scale',
      String(preferences.scale / 100)
    )

    document.documentElement.classList.toggle(
      'ultron-reduced-motion',
      !preferences.motionEnabled
    )
  }, [preferences, preferencesStorageKey])

  useEffect(() => {
    const updateClock = () => {
      const now =
        new Date()

      setTime(
        new Intl.DateTimeFormat(
          'it-IT',
          {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }
        ).format(now)
      )

      setDate(
        new Intl.DateTimeFormat(
          'it-IT',
          {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }
        ).format(now)
      )
    }

    updateClock()

    const interval =
      setInterval(
        updateClock,
        1000
      )

    return () =>
      clearInterval(
        interval
      )
  }, [])

  async function loadSystem() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/system`
        )

      if (!response.ok) {
        setBackendOnline(false)
        return
      }

      const data =
        await response.json()

      setSystem(data)
      setBackendOnline(true)

      setHistory(
        previous => ({
          cpu: [
            ...previous.cpu,
            data.cpu_percent,
          ].slice(-40),

          ram: [
            ...previous.ram,
            data.ram_percent,
          ].slice(-40),

          download: [
            ...previous.download,
            data.download_mbps,
          ].slice(-40),

          upload: [
            ...previous.upload,
            data.upload_mbps,
          ].slice(-40),
        })
      )
    } catch {
      setBackendOnline(false)
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadSystem()
    }, 0)

    const interval =
      setInterval(
        loadSystem,
        1500
      )

    return () => {
      window.clearTimeout(initialLoad)
      clearInterval(
        interval
      )
    }
  }, [])

  async function loadPrinterStatus() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/printer/status`
        )

      if (!response.ok)
        return

      const data =
        await response.json()

      setPrinterStatus(data)
    } catch {
      setPrinterStatus({
        connected: false,
        status: 'NOT CONNECTED',
        port: null,
        progress: null,
      })
    }
  }

  async function refreshDevices() {
    if (isRefreshing) return

    setIsRefreshing(true)

    try {
      await Promise.all([
        loadSystem(),
        loadPrinterStatus(),
      ])
    } finally {
      setIsRefreshing(false)
    }
  }

  async function openMakerWorld() {
    try {
      const response = await fetch(
        `${BACKEND}/api/system/open-makerworld`,
        { method: 'POST' }
      )

      if (!response.ok) {
        throw new Error('MakerWorld unavailable')
      }
    } catch {
      window.open(
        'https://makerworld.com/',
        '_blank',
        'noopener,noreferrer'
      )
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadPrinterStatus()
    }, 0)

    const timer =
      setInterval(
        loadPrinterStatus,
        2500
      )

    return () => {
      window.clearTimeout(initialLoad)
      clearInterval(timer)
    }
  }, [])

  async function archiveChatMessage(text) {
    try {
      const response = await fetch(`${BACKEND}/api/obsidian/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        return {
          ok: false,
          error: result.detail || result.error || 'ULTRON could not write this command to Obsidian.',
        }
      }

      void loadObsidian()
      return result
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'ULTRON Core is unavailable.',
      }
    }
  }

  async function sendAgentMessage(
    message,
    options = {}
  ) {
    const clean =
      message.trim()

    const archiveToObsidian = Boolean(
      options?.archiveToObsidian
    )

    if (!clean || agentSendingRef.current) {
      return
    }

    agentSendingRef.current = true

    if (archiveToObsidian) {
      setObsidianArmed(false)
    }

    const archivePromise = archiveToObsidian
      ? archiveChatMessage(clean)
      : null

    const userMessage = {
      id: createChatMessageId(),
      role: "user",
      text: clean,
      speak: false,
      createdAt: createChatMessageTimestamp(),
    }

    const conversationHistory = agentMessagesRef.current
      .slice(-8)
      .filter(item => item?.text && ['user', 'assistant'].includes(item.role))
      .map(item => ({
        role: item.role,
        text: String(item.text).slice(0, 1600),
      }))

    setAgentMessages(
      previous => {
        const next = [...previous, userMessage]
        agentMessagesRef.current = next
        return next
      }
    )

    setAgentInput("")
    setAgentSending(true)

    try {
      const response =
        await fetch(
          `${BACKEND}/api/agent`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              message: clean,
              history: conversationHistory,
            }),
          }
        )

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        )
      }

      const data =
        await response.json()

      const obsidianArchive = archivePromise
        ? await archivePromise
        : null

      const reply =
        data.reply ||
        "Command received."

      setAgentMessages(
        previous => {
          const next = [
            ...previous,
            {
              id: createChatMessageId(),
              role: "assistant",
              text: reply,
              speak: true,
              createdAt: Date.now(),
              memoryProposal: data.memory_proposal
                ? { ...data.memory_proposal, status: 'pending' }
                : null,
              emailDraft: data.email_draft
                ? { ...data.email_draft, status: 'pending' }
                : null,
              obsidianArchive,
            },
          ]
          agentMessagesRef.current = next
          return next
        }
      )

      if (preferences.voiceEnabled) {
        void speakWithFish(reply)
      }

    } catch {
      const obsidianArchive = archivePromise
        ? await archivePromise
        : null

      const reply =
        "I can't reach the ULTRON core right now."

      setAgentMessages(
        previous => {
          const next = [
            ...previous,
            {
              id: createChatMessageId(),
              role: "assistant",
              text: reply,
              speak: true,
              createdAt: Date.now(),
              obsidianArchive,
            },
          ]
          agentMessagesRef.current = next
          return next
        }
      )

      if (preferences.voiceEnabled) {
        void speakWithFish(reply)
      }
    } finally {
      agentSendingRef.current = false
      setAgentSending(false)
    }
  }

  function updateAgentAction(messageId, actionKey, changes) {
    setAgentMessages(previous => previous.map(message => (
      message.id === messageId
        ? {
            ...message,
            [actionKey]: {
              ...message[actionKey],
              ...changes,
            },
          }
        : message
    )))
  }

  async function commitMemoryProposal(messageId, proposal) {
    if (!proposal?.id || proposal.status === 'saving' || proposal.status === 'saved') return

    updateAgentAction(messageId, 'memoryProposal', {
      status: 'saving',
      error: '',
    })

    try {
      const response = await fetch(`${BACKEND}/api/memory/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: proposal.id }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Unable to save the memory.')
      }

      updateAgentAction(messageId, 'memoryProposal', {
        status: 'saved',
        error: '',
      })
      setAgentMessages(previous => [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: `${result.saved || proposal.items?.length || 1} element${Number(result.saved || proposal.items?.length || 1) === 1 ? '' : 's'} committed to the Neural Core.`,
          speak: false,
          createdAt: Date.now(),
        },
      ])
    } catch (error) {
      updateAgentAction(messageId, 'memoryProposal', {
        status: 'pending',
        error: error?.message || 'Unable to save the memory.',
      })
    }
  }

  function discardMemoryProposal(messageId, proposal) {
    if (proposal?.status === 'saving' || proposal?.status === 'saved') return

    updateAgentAction(messageId, 'memoryProposal', {
      status: 'discarded',
      error: '',
    })
  }

  async function sendEmailDraft(messageId, draft) {
    if (!draft || draft.status === 'sending' || draft.status === 'sent') return

    updateAgentAction(messageId, 'emailDraft', {
      status: 'sending',
      error: '',
    })

    try {
      const response = await fetch(`${BACKEND}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: draft.to || [],
          subject: draft.subject || '',
          body: draft.body || '',
        }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.detail || result.error || 'Mail could not send this transmission.')
      }

      updateAgentAction(messageId, 'emailDraft', {
        status: 'sent',
        error: '',
      })
      setAgentMessages(previous => [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: result.message || 'Transmission sent through Mail.',
          speak: false,
          createdAt: Date.now(),
        },
      ])
    } catch (error) {
      updateAgentAction(messageId, 'emailDraft', {
        status: 'failed',
        error: error?.message || 'Mail could not send this transmission.',
      })
    }
  }

  async function loadWeather(
    latitude,
    longitude,
    label
  ) {
    try {
      const response =
        await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,weather_code&timezone=auto`
        )

      if (!response.ok)
        return

      const data =
        await response.json()

      setWeather({
        temperature:
          data.current
            .temperature_2m,

        code:
          data.current
            .weather_code,

        label,
      })
    } catch {
      // Weather unavailable.
    }
  }

  useEffect(() => {
    if (!hasStoredCoordinates(weatherConfig)) return

    void loadWeather(
      weatherConfig.lat,
      weatherConfig.lon,
      weatherConfig.label || 'LOCAL AREA'
    )
    // This app instance is mounted for one signed-in account; later edits load via saveWeather.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadObsidian() {
    try {
      const statusResponse =
        await fetch(
          `${BACKEND}/api/obsidian/status`
        )

      if (!statusResponse.ok)
        return

      const status =
        await statusResponse.json()

      setObsidianStatus(
        status
      )

      if (status.path) {
        setObsidianPath(
          status.path
        )
      }

      if (status.connected) {
        const graphResponse =
          await fetch(
            `${BACKEND}/api/obsidian/graph`
          )

        if (!graphResponse.ok)
          return

        const graph =
          await graphResponse.json()

        setObsidianGraph(
          graph
        )
      }
    } catch {
      // Backend offline.
    }
  }

  useEffect(() => {
    loadObsidian()
  }, [])

  async function saveObsidian() {
    try {
      const response =
        await fetch(
          `${BACKEND}/api/obsidian/config`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',
            },

            body: JSON.stringify({
              path:
                obsidianPath,
            }),
          }
        )

      const result =
        await response.json()

      if (!result.ok) {
        alert(
          result.error ||
            'Errore Obsidian'
        )

        return
      }

      await loadObsidian()
    } catch {
      alert(
        'Backend ULTRON non disponibile.'
      )
    }
  }

  function saveWeather(config = weatherConfig) {
    localStorage.setItem(
      weatherStorageKey,
      JSON.stringify(
        config
      )
    )

    if (hasStoredCoordinates(config)) {
      loadWeather(
        config.lat,
        config.lon,
        config.label ||
          'LOCAL AREA'
      )
    }
  }

  function applyGlobalPosition(location) {
    const next = {
      label: String(location?.shortLabel || location?.label || 'LOCAL AREA').slice(0, 120),
      lat: String(location?.lat ?? ''),
      lon: String(location?.lon ?? ''),
    }

    setWeatherConfig(next)
    saveWeather(next)
  }

  function handleVoiceWake() {
    const reply = 'Dimmi pure.'

    setAgentMessages(previous => {
      const last = previous[previous.length - 1]
      if (last?.role === 'assistant' && last.text === reply) return previous

      const next = [
        ...previous,
        {
          id: createChatMessageId(),
          role: 'assistant',
          text: reply,
          speak: false,
          createdAt: createChatMessageTimestamp(),
        },
      ]
      agentMessagesRef.current = next
      return next
    })

  }

  const voice = useUltronVoice({
    onCommand: sendAgentMessage,
    onWake: handleVoiceWake,
  })

  function dismissOnboarding() {
    markOnboardingComplete(accountScope)
    setOnboardingOpen(false)
  }

  const cpu =
    system?.cpu_percent

  const ram =
    system?.ram_percent

  const disk =
    system?.disk_percent

  const download =
    system?.download_mbps

  const upload =
    system?.upload_mbps

  return (
    <div
      className={`ultron page-${activePage.toLowerCase().replace(/_/g, '-')}`}
    >

      <div className="honeycomb-bg">
        <svg
          viewBox="0 0 900 700"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern
              id="hex"
              width="86"
              height="100"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M43 2L84 26V74L43 98L2 74V26L43 2Z"
                fill="none"
                stroke="#ff2525"
                strokeOpacity="0.13"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          <rect
            width="100%"
            height="100%"
            fill="url(#hex)"
          />
        </svg>
      </div>

      <div className="ground-glow" />

      <header className="topbar">
        <div className="logo">
          <img
            className="brand-mark"
            src="./ultron-mark.png"
            alt=""
          />

          <div className="logo-copy">
            <span className="logo-word">
              ULTRON
            </span>

            <span className="logo-ai">
              PRIVATE INTELLIGENCE
            </span>
          </div>
        </div>

        <div className="top-status">
          <div className="top-online" role="status" aria-label="ULTRON online">
            <span className="status-dot" />
            <span>ONLINE</span>
          </div>

          <div className="top-status-meta">
            <span>
              {weather
                ? `${weatherIcon(
                    weather.code
                  )} ${weather.temperature}°C`
                : '☁ —'}
            </span>

            <span>
              {weather?.label ||
                'LOCAL AREA'}
            </span>

            <span>
              {date}
            </span>

            <strong>
              {time}
            </strong>
          </div>
        </div>

        <div className="top-account" aria-label="Current local account">
          <div>
            <span>OPERATOR</span>
            <strong title={accountName}>{accountName}</strong>
          </div>
          <button type="button" onClick={onLogout} title="Sign out of this local account">
            SIGN OUT
          </button>
        </div>
      </header>

      <aside className="menu">

        <div className="menu-label">COMMAND</div>

        {NAVIGATION_ITEMS.map(
          item => (
            <button
              key={item.id}
              className={
                activePage ===
                item.id
                  ? 'active'
                  : ''
              }
              onClick={() =>
                setActivePage(
                  item.id
                )
              }
            >
              <span className="menu-button-main">
                <NavIcon name={item.icon} />
                <span>{item.label}</span>
              </span>
              <span className="menu-indicator" />
            </button>
          )
        )}

      </aside>

      <main className="brain-area">

        <div
          className="core-hud"
          aria-hidden="true"
        >
          <i className="hud-corner hud-corner-nw" />
          <i className="hud-corner hud-corner-ne" />
          <i className="hud-corner hud-corner-sw" />
          <i className="hud-corner hud-corner-se" />
          <span className="hud-readout hud-readout-left">
            CORE LINK // 01
          </span>
          <span className="hud-readout hud-readout-right">
            NEURAL LOCK
          </span>
        </div>

        <div className="brain-title">
          <span>COGNITIVE DOMINION</span>
          NEURAL CORE
        </div>

        <Brain3D onSelect={setSelected} />


        {selected && (
          <div
            key={selected.id}
            className="selection-card"
          >
            <div className="selection-card-head">
              <div className="selection-label">SELECTED NODE</div>
              <span>LOCKED</span>
            </div>

            <div className="selection-name">
              {selected.name}
            </div>

            <p className="selection-description">
              {selected.description}
            </p>

            <div className="selection-data">
              <div><span>RELATION</span><strong>{selected.relation}</strong></div>
              <div><span>TYPE</span><strong>{selected.type}</strong></div>
              <div><span>SOURCE</span><strong>{selected.source}</strong></div>
              <div><span>LINKS</span><strong>{selected.linkCount || 0}</strong></div>
            </div>

            {selected.path && <div className="selection-path">{selected.path}</div>}

            <button
              type="button"
              className="selection-open-memory"
              onClick={() => setActivePage('MEMORY')}
            >
              OPEN MEMORY ARCHIVE
            </button>
          </div>
        )}

        <div className="page-panel">

          {activePage ===
            'AGENT' && (
              <AgentChat
                messages={agentMessages}
                input={agentInput}
                setInput={setAgentInput}
                sending={agentSending}
                onSend={sendAgentMessage}
                onCommitMemory={commitMemoryProposal}
                onDiscardMemory={discardMemoryProposal}
                onSendEmail={sendEmailDraft}
                obsidianArmed={obsidianArmed}
                onToggleObsidian={() => setObsidianArmed(current => !current)}
                voice={voice}
              />
          )}

          {activePage ===
            'MEMORY' && (
            <MemoryPage
              obsidianStatus={obsidianStatus}
              obsidianGraph={obsidianGraph}
              onOpenSettings={() => setActivePage('SETTINGS')}
            />
          )}

          {activePage ===
            'SETTINGS' && (
            <SettingsPage
              obsidianPath={obsidianPath}
              setObsidianPath={setObsidianPath}
              saveObsidian={saveObsidian}
              obsidianStatus={obsidianStatus}
              weatherConfig={weatherConfig}
              saveWeather={saveWeather}
              onSaveGlobalPosition={applyGlobalPosition}
              preferences={preferences}
              setPreferences={setPreferences}
              backendOnline={backendOnline}
              printerStatus={printerStatus}
              onOpenTutorial={() => setOnboardingOpen(true)}
            />
          )}

          {activePage ===
            'DEVICES' && (
            <DevicesPage
              system={system}
              history={history}
              printerStatus={printerStatus}
              backendOnline={backendOnline}
              onRefresh={refreshDevices}
              onOpenMakerWorld={openMakerWorld}
              onOpenModelDeck={() => setActivePage('MODEL_DECK')}
              isRefreshing={isRefreshing}
            />
          )}

          {activePage ===
            'MODEL_DECK' && (
            <Suspense fallback={<div className="model-deck-loading">LOADING MODEL DECK…</div>}>
              <ModelDeckPage
                onBack={() => setActivePage('DEVICES')}
                backendOnline={backendOnline}
                printerStatus={printerStatus}
              />
            </Suspense>
          )}

        </div>

      </main>

      <aside className="system-panel">

        <div className="panel-title">
          <div>
            <span>LOCAL SYSTEM</span>
            <strong>{system?.hostname || 'LOCAL HOST'}</strong>
          </div>
          <span className="system-live">LIVE</span>
        </div>

        <SystemCard
          label="CPU"
          value={
            cpu === undefined
              ? '—'
              : `${cpu}%`
          }
          progress={cpu}
          values={
            history.cpu
          }
        />

        <SystemCard
          label="RAM"
          value={
            ram === undefined
              ? '—'
              : `${ram}%`
          }
          sub={
            system
              ? `${system.ram_used_gb} / ${system.ram_total_gb} GB`
              : ''
          }
          progress={ram}
          values={
            history.ram
          }
        />

        <SystemCard
          label="DISCO"
          value={
            system
              ? `${system.disk_free_gb} GB`
              : '—'
          }
          sub={
            system
              ? `${system.disk_total_gb} GB TOTAL`
              : ''
          }
          progress={
            disk !== undefined
              ? 100 - disk
              : undefined
          }
        />

        <SystemCard
          label="RETE"
          value="ONLINE"
          sub={`${download ?? '—'} ↓ / ${upload ?? '—'} ↑ Mbps`}
          values={[
            ...history.download,
            ...history.upload,
          ]}
        />

        <SystemCard
          label="3D PRINTER"
          value={
            printerStatus.connected
              ? 'ONLINE'
              : 'WAITING'
          }
          sub={
            printerStatus.connected
              ? `${printerStatus.status} · ${
                  printerStatus.port
                    ? printerStatus.port
                        .split('/')
                        .pop()
                    : printerStatus.baseUrl
                      ? 'WI-FI / LAN'
                      : 'LOCAL LINK'
                }`
              : printerStatus.profileId
                ? 'PROFILE SAVED · NOT CONNECTED'
                : 'CONFIGURE IN DEVICES'
          }
          progress={
            typeof printerStatus.progress === 'number'
              ? printerStatus.progress
              : undefined
          }
        />

      </aside>

      {onboardingOpen && (
        <OnboardingTutorial
          accountName={accountName}
          onDismiss={dismissOnboarding}
          onOpenSettings={() => setActivePage('SETTINGS')}
          onOpenDevices={() => setActivePage('DEVICES')}
        />
      )}

    </div>
  )
}

export default App
