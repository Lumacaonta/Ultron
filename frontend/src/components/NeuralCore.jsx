import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  ConeGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  Raycaster,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TetrahedronGeometry,
  Timer,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WireframeGeometry
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useEffect, useRef, useState } from 'react'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'
import { describeCoreNode, isHiddenGraphNode } from './neuralCoreData.js'

function hasWebGLRenderer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }

  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl')
    )
  } catch {
    return false
  }
}

export default function NeuralCore({ onSelect }) {
  const mountRef = useRef(null)
  const animationRef = useRef(0)
  const [renderUnavailable, setRenderUnavailable] = useState(() => !hasWebGLRenderer())

  useEffect(() => {
    if (renderUnavailable) {
      return undefined
    }

    const mount = mountRef.current

    if (!mount) {
      return undefined
    }

    const scene = new Scene()
    const nodeAmbientLight = new AmbientLight(0x5b1419, 1.55)
    const nodeKeyLight = new DirectionalLight(0xffd8d0, 2.1)
    nodeKeyLight.position.set(-2.4, 3.1, 5.2)
    const nodeRimLight = new PointLight(0xff322c, 1.7, 14, 2)
    nodeRimLight.position.set(3.6, -1.5, -3.2)
    scene.add(nodeAmbientLight, nodeKeyLight, nodeRimLight)

    const camera =
      new PerspectiveCamera(
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

    let renderer

    try {
      renderer =
        new WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference:
          "high-performance",
        })
    } catch {
      /*
       * WebGL can be disabled by a remote desktop session, an accessibility
       * browser, or a machine policy. The rest of ULTRON must remain usable
       * when its decorative 3D visualizer is unavailable.
       */
      const retryTimer = window.setTimeout(() => setRenderUnavailable(true), 0)
      return () => window.clearTimeout(retryTimer)
    }

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
      new Group()

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
      new Group()

    const labelWorldPosition =
      new Vector3()

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
        new Vector3(
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
        new MeshBasicMaterial({
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
        new Mesh(
          new SphereGeometry(
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
      new BufferGeometry()

    connectionGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(
        connectionPoints,
        3
      )
    )

    brain.add(
      new LineSegments(
        connectionGeometry,
        new LineBasicMaterial({
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
      new Mesh(
        new IcosahedronGeometry(
          3.32,
          3
        ),
        new MeshBasicMaterial({
          color: 0x7d1016,
          wireframe: true,
          transparent: true,
          opacity: 0.13,
          blending:
            AdditiveBlending,
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
        new LineSegments(
          new WireframeGeometry(
            new IcosahedronGeometry(
              spec.radius,
              1
            )
          ),
          new LineBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: spec.opacity,
            blending:
              AdditiveBlending,
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
    const exteriorShell = new Group()
    const sphereShells = [
      {
        geometry: new IcosahedronGeometry(3.26, 2),
        scale: [1.02, 0.94, 0.98],
        rotation: [0.3, -0.44, 0.12],
        color: 0xb41620,
        opacity: 0.26,
        speed: 0.00042,
      },
      {
        geometry: new DodecahedronGeometry(3.31, 1),
        scale: [0.96, 1.02, 1],
        rotation: [-0.68, 0.26, -0.38],
        color: 0xff3d3d,
        opacity: 0.18,
        speed: -0.00031,
      },
      {
        geometry: new IcosahedronGeometry(3.36, 1),
        scale: [1, 0.97, 1.01],
        rotation: [0.82, 0.61, 0.3],
        color: 0x7f1119,
        opacity: 0.30,
        speed: 0.00022,
      },
    ]

    sphereShells.forEach((spec) => {
      const shell = new LineSegments(
        new WireframeGeometry(spec.geometry),
        new LineBasicMaterial({
          color: spec.color,
          transparent: true,
          opacity: spec.opacity,
          blending: AdditiveBlending,
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

    const surfaceGeometry = new BufferGeometry()
    surfaceGeometry.setAttribute(
      'position',
      new Float32BufferAttribute(surfacePositions, 3)
    )
    surfaceGeometry.setAttribute(
      'color',
      new Float32BufferAttribute(surfaceColors, 3)
    )

    const surfaceBeacons = new Points(
      surfaceGeometry,
      new PointsMaterial({
        size: 0.06,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: AdditiveBlending,
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
      new Group()

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
        new Vector3(
          Math.cos(theta) * radial,
          y,
          Math.sin(theta) * radial
        ).normalize()

      const tangent =
        new Vector3(
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
          new LineSegments(
            new WireframeGeometry(
              new TetrahedronGeometry(
                0.1 + (index % 4) * 0.02,
                0
              )
            ),
            new LineBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff756d
                  : 0xa8131c,
              transparent: true,
              opacity: 0.52,
              blending:
                AdditiveBlending,
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
      new LineSegments(
        new BufferGeometry().setFromPoints(
          fractureSegments
        ),
        new LineBasicMaterial({
          color: 0xd41d25,
          transparent: true,
          opacity: 0.42,
          blending:
            AdditiveBlending,
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
        new CanvasTexture(
          canvas
        )

      texture.colorSpace =
        SRGBColorSpace

      const sprite =
        new Sprite(
          new SpriteMaterial({
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
      const node = new Group()
      const core = new Mesh(
        new SphereGeometry(
          radius,
          isAnchor ? 20 : 16,
          isAnchor ? 16 : 12
        ),
        new MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: isAnchor ? 0.94 : 0.6,
          metalness: 0.5,
          roughness: 0.23,
          transparent: true,
          opacity: isAnchor ? 0.98 : 0.95,
        })
      )

      const atmosphere = new Mesh(
        new SphereGeometry(
          radius * (isAnchor ? 1.72 : 1.5),
          14,
          10
        ),
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity: isAnchor ? 0.075 : 0.05,
          blending: AdditiveBlending,
          depthWrite: false,
        })
      )

      core.userData.nodeRoot = node
      atmosphere.userData.nodeRoot = node
      node.add(core, atmosphere)

      const orbits = new Group()
      const orbitSpecs = isAnchor
        ? [[1.56, 0.68, 0.22, 0.42], [1.72, -0.46, 0.78, -0.3]]
        : [[1.48, 0.7, 0.2, 0.36]]

      orbitSpecs.forEach(([distance, x, y, z]) => {
        const orbit = new Mesh(
          new TorusGeometry(
            radius * distance,
            Math.max(0.008, radius * 0.055),
            6,
            28
          ),
          new MeshBasicMaterial({
            color,
            transparent: true,
            opacity: isAnchor ? 0.34 : 0.24,
            blending: AdditiveBlending,
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

      return new Vector3(
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
          new Vector3(
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
      new Mesh(
        new SphereGeometry(
          0.34,
          24,
          24
        ),
        new MeshBasicMaterial({
          color: 0xff1010,
          transparent: true,
          opacity: 0.04,
          blending:
            AdditiveBlending,
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
      new Group()

    const reactorCore =
      new Mesh(
        new SphereGeometry(
          0.12,
          20,
          20
        ),
        new MeshBasicMaterial({
          color: 0xff4b44,
          transparent: true,
          opacity: 0.48,
          blending:
            AdditiveBlending,
          depthWrite: false,
        })
      )

    const reactorHalo =
      new LineSegments(
        new WireframeGeometry(
          new IcosahedronGeometry(
            0.34,
            2
          )
        ),
        new LineBasicMaterial({
          color: 0xff1414,
          transparent: true,
          opacity: 0.14,
          blending:
            AdditiveBlending,
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
          ? new DodecahedronGeometry(
              spec.radius,
              0
            )
          : new OctahedronGeometry(
              spec.radius,
              1
            )

      const cage =
        new LineSegments(
          new WireframeGeometry(
            cageGeometry
          ),
          new LineBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: spec.opacity,
            blending:
              AdditiveBlending,
            depthWrite: false,
          })
        )

      cage.rotation.set(...spec.rotation)
      cage.userData.speed = spec.speed
      return cage
    })

    const reactorShardShell =
      new LineSegments(
        new WireframeGeometry(
          new DodecahedronGeometry(
            0.38,
            0
          )
        ),
        new LineBasicMaterial({
          color: 0xff837a,
          transparent: true,
          opacity: 0.12,
          blending:
            AdditiveBlending,
          depthWrite: false,
        })
      )

    const reactorBlades = Array.from(
      { length: 0 },
      (_, index) => {
        const angle =
          (Math.PI * 2 * index) / 6

        const blade =
          new Mesh(
            new TetrahedronGeometry(
              index % 2 ? 0.17 : 0.13,
              0
            ),
            new MeshBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff7067
                  : 0xce1a22,
              transparent: true,
              opacity: 0.84,
              blending:
                AdditiveBlending,
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
          new Vector3(
            Math.cos(angle) * radial,
            y,
            Math.sin(angle) * radial
          ).normalize()

        const lance =
          new Mesh(
            new ConeGeometry(
              0.052 + (index % 3) * 0.013,
              0.42 + (index % 4) * 0.07,
              4,
              1
            ),
            new MeshBasicMaterial({
              color:
                index % 4 === 0
                  ? 0xffa099
                  : 0xc21420,
              transparent: true,
              opacity: 0.6,
              blending:
                AdditiveBlending,
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
          new Vector3(0, 1, 0),
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
          new Mesh(
            new OctahedronGeometry(
              0.055 + (index % 3) * 0.025,
              0
            ),
            new MeshBasicMaterial({
              color:
                index % 2
                  ? 0xff413b
                  : 0xffaaa3,
              transparent: true,
              opacity: 0.67,
              blending:
                AdditiveBlending,
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
      new Group()

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

      return new Vector3(
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
            new BufferGeometry().setFromPoints(
              [
                source.position,
                target.position,
              ]
            )

          const line =
            new Line(
              geometry,
              new LineBasicMaterial({
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
        new Mesh(
          new SphereGeometry(
            0.028,
            6,
            6
          ),
          new MeshBasicMaterial({
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
          new Vector3(
            Math.sin(phase * 2.1) * 0.46,
            Math.cos(phase * 1.4) * 0.34,
            Math.cos(phase * 1.9) * 0.42
          )

        const curve =
          new CatmullRomCurve3(
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
          new Line(
            new BufferGeometry().setFromPoints(
              curve.getPoints(26)
            ),
            new LineBasicMaterial({
              color:
                index % 3 === 0
                  ? 0xff9a92
                  : 0xb51620,
              transparent: true,
              opacity: 0.12,
              blending:
                AdditiveBlending,
              depthWrite: false,
            })
          )

        const packet =
          new Mesh(
            new OctahedronGeometry(
              index % 2 ? 0.038 : 0.052,
              0
            ),
            new MeshBasicMaterial({
              color: 0xff8f87,
              transparent: true,
              opacity: 0.96,
              blending:
                AdditiveBlending,
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
      new Raycaster()

    const pointer =
      new Vector2()

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

    const timer =
      new Timer()

    timer.connect(document)

    function animate() {
      animationRef.current =
        requestAnimationFrame(
          animate
        )

      const time =
        timer
          .update()
          .getElapsed()

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
            new Vector3(0, 1, 0)

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

          const rawProgress =
            (time * speed + trace.phase) % 1

          const progress =
            Number.isFinite(rawProgress)
              ? (rawProgress + 1) % 1
              : 0

          const curvePoints =
            trace.curve?.points

          const curveIsUsable =
            Array.isArray(curvePoints) &&
            curvePoints.length >= 2 &&
            curvePoints.every(point => (
              point &&
              Number.isFinite(point.x) &&
              Number.isFinite(point.y) &&
              Number.isFinite(point.z)
            ))

          if (curveIsUsable) {
            const point =
              trace.curve.getPointAt(progress)

            if (
              Number.isFinite(point?.x) &&
              Number.isFinite(point?.y) &&
              Number.isFinite(point?.z)
            ) {
              trace.packet.position.copy(point)
            }
          }

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
      timer.dispose()

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
  }, [onSelect, renderUnavailable])

  if (renderUnavailable) {
    return (
      <div
        className="brain-renderer brain-renderer-fallback"
        role="status"
        aria-live="polite"
      >
        <div className="brain-fallback-signal" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>NEURAL VISUALIZER STANDBY</span>
        <strong>3D GRAPHICS ARE UNAVAILABLE</strong>
        <p>
          Ultron AI remains available. You can use Agent, Memory, Devices and
          Settings while this environment has no WebGL renderer.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={mountRef}
      className="brain-renderer"
      aria-label="Ultron AI neural core"
    />
  )
}
