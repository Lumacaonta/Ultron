import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Timer,
  Vector3,
  WebGLRenderer,
  WireframeGeometry
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const GLOBE_RADIUS = 2.36
const MARKER_CLEARANCE = 0.032

/* Broad, readable coast silhouettes. Their coordinates are shared by the
 * texture and raised outlines so the selected point is geographically coherent. */
const LANDMASSES = [
  [[-168,72],[-151,70],[-139,61],[-128,52],[-123,47],[-117,34],[-108,29],[-102,23],[-94,19],[-84,25],[-80,31],[-75,39],[-69,45],[-61,49],[-65,56],[-80,61],[-94,70],[-113,74],[-140,76]],
  [[-82,12],[-78,5],[-76,-5],[-72,-15],[-68,-23],[-63,-34],[-56,-43],[-52,-54],[-44,-55],[-36,-45],[-35,-26],[-43,-12],[-50,-2],[-59,7],[-70,12]],
  [[-18,35],[-10,42],[-2,50],[11,55],[27,58],[44,59],[63,57],[76,54],[94,56],[111,54],[128,50],[145,48],[153,42],[144,32],[133,24],[122,16],[112,8],[104,2],[96,8],[87,22],[76,24],[67,29],[58,32],[49,30],[42,36],[32,40],[23,39],[15,43],[8,39],[-1,43],[-9,38]],
  [[-17,35],[-6,35],[4,35],[13,32],[21,30],[31,31],[35,22],[40,12],[43,2],[41,-11],[34,-23],[27,-31],[17,-35],[8,-29],[1,-22],[-5,-8],[-9,7],[-15,22]],
  [[111,-11],[116,-20],[124,-24],[132,-34],[143,-39],[151,-33],[154,-25],[151,-15],[141,-11],[130,-10],[120,-12]],
  [[-52,60],[-43,66],[-38,73],[-28,78],[-18,76],[-21,67],[-32,59],[-44,59]],
  [[-11,51],[-6,56],[-3,58],[1,56],[1,52],[-4,50]],
  [[130,32],[136,35],[141,41],[145,39],[145,34],[139,32]],
  [[47,-13],[51,-16],[50,-24],[44,-25],[42,-18]],
  [[95,5],[103,3],[110,-4],[116,-7],[121,-4],[118,2],[108,6],[100,6]],
]

const GLOBAL_HUBS = [
  [-122.42,37.77],[-74.01,40.71],[-99.13,19.43],[-46.63,-23.55],
  [-0.13,51.51],[12.5,41.9],[28.98,41.01],[31.24,30.04],
  [55.27,25.2],[77.1,28.7],[103.82,1.35],[139.69,35.68],
  [151.21,-33.87],[18.42,-33.92],
]

const GLOBAL_ROUTES = [[0,1],[1,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[1,2],[2,3],[4,13]]

function isCoordinate(value, lower, upper) {
  if (value === '' || value === null || value === undefined) return false
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= lower && numeric <= upper
}

function hasCoordinates(latitude, longitude) {
  return isCoordinate(latitude, -90, 90) && isCoordinate(longitude, -180, 180)
}

function hasWebGLRenderer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false

  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function latLonVector(latitude, longitude, radius = GLOBE_RADIUS) {
  const lat = MathUtils.degToRad(Number(latitude))
  const lon = MathUtils.degToRad(Number(longitude))
  const cosLat = Math.cos(lat)
  return new Vector3(radius * cosLat * Math.sin(lon), radius * Math.sin(lat), radius * cosLat * Math.cos(lon))
}

function createLine(points, color, opacity = 1) {
  const geometry = new BufferGeometry().setFromPoints(points)
  const material = new LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false })
  return new Line(geometry, material)
}

function createGeoRoute(coordinates, radius, color, opacity, closed = false) {
  const points = []
  const count = coordinates.length
  const limit = closed ? count : count - 1
  for (let index = 0; index < limit; index += 1) {
    const from = coordinates[index]
    const to = coordinates[(index + 1) % count]
    const start = latLonVector(from[1], from[0], radius)
    const end = latLonVector(to[1], to[0], radius)
    const divisions = Math.max(2, Math.ceil(start.angleTo(end) / 0.07))
    for (let step = 0; step <= divisions; step += 1) {
      if (index > 0 && step === 0) continue
      points.push(start.clone().lerp(end, step / divisions).normalize().multiplyScalar(radius))
    }
  }
  return createLine(points, color, opacity)
}

function drawLandPath(context, points, width, height) {
  context.beginPath()
  points.forEach(([longitude, latitude], index) => {
    const x = ((longitude + 180 + 360) % 360) / 360 * width
    const y = (90 - latitude) / 180 * height
    if (index === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  })
  context.closePath()
}

function createWorldTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1536
  canvas.height = 768
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const ocean = context.createRadialGradient(width * 0.52, height * 0.46, 18, width * 0.5, height * 0.5, width * 0.68)
  ocean.addColorStop(0, '#2b0711')
  ocean.addColorStop(0.42, '#13040b')
  ocean.addColorStop(1, '#040306')
  context.fillStyle = ocean
  context.fillRect(0, 0, width, height)

  context.save()
  context.globalAlpha = 0.26
  context.strokeStyle = '#a62335'
  context.lineWidth = 1
  for (let latitude = 0; latitude <= height; latitude += 64) {
    context.beginPath()
    context.moveTo(0, latitude)
    context.lineTo(width, latitude)
    context.stroke()
  }
  for (let longitude = 0; longitude <= width; longitude += 96) {
    context.beginPath()
    context.moveTo(longitude, 0)
    context.lineTo(longitude, height)
    context.stroke()
  }
  context.restore()

  LANDMASSES.forEach((landmass) => {
    drawLandPath(context, landmass, width, height)
    const land = context.createLinearGradient(0, 0, width, height)
    land.addColorStop(0, 'rgba(255, 92, 109, 0.72)')
    land.addColorStop(0.52, 'rgba(179, 18, 39, 0.57)')
    land.addColorStop(1, 'rgba(96, 8, 24, 0.72)')
    context.fillStyle = land
    context.fill()
    context.lineWidth = 2
    context.strokeStyle = 'rgba(255, 162, 172, 0.94)'
    context.stroke()
    context.save()
    drawLandPath(context, landmass, width, height)
    context.clip()
    context.strokeStyle = 'rgba(255, 209, 212, 0.14)'
    context.lineWidth = 1
    for (let x = -height; x < width + height; x += 32) {
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x + height * 0.36, height)
      context.stroke()
    }
    context.restore()
  })
  const vignette = context.createRadialGradient(width * 0.5, height * 0.5, height * 0.16, width * 0.5, height * 0.5, width * 0.66)
  vignette.addColorStop(0.56, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.58)')
  context.fillStyle = vignette
  context.fillRect(0, 0, width, height)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  // SphereGeometry's u=0 seam is at -90°. Shift a conventional world map
  // by a quarter turn so its seam stays in the Pacific instead of bisecting
  // North America and the selected coordinate still matches its coastline.
  texture.wrapS = RepeatWrapping
  texture.offset.x = 0.25
  return texture
}

function createMarkerTag() {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 116
  const context = canvas.getContext('2d')
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }))
  sprite.scale.set(1.7, 0.41, 1)
  sprite.position.y = 1.62
  return { canvas, context, texture, sprite }
}

function drawMarkerTag(markerTag, label) {
  const { canvas, context, texture } = markerTag
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'rgba(10, 2, 7, 0.9)'
  context.fillRect(5, 10, canvas.width - 10, canvas.height - 20)
  context.strokeStyle = 'rgba(255, 75, 94, 0.86)'
  context.lineWidth = 3
  context.strokeRect(5, 10, canvas.width - 10, canvas.height - 20)
  context.fillStyle = '#ff6575'
  context.font = '700 20px ui-monospace, Menlo, monospace'
  context.fillText('POSITION LOCK', 26, 43)
  context.fillStyle = '#fff3f4'
  context.font = '700 27px ui-monospace, Menlo, monospace'
  context.fillText(String(label || 'GLOBAL POSITION').toUpperCase().slice(0, 28), 26, 80)
  texture.needsUpdate = true
}

function disposeObject(root) {
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) value.dispose()
      })
      material.dispose?.()
    })
  })
}

/* The marker and map are children of the same rotated world group.  The camera
 * uses `matrixWorld` for the selected surface normal, fixing the old mismatch
 * that could focus the rear or side of a rotated globe. */
export default function GlobalPositionGlobe({ latitude, longitude, label, active = false }) {
  const containerRef = useRef(null)
  const runtimeRef = useRef(null)
  const [renderUnavailable, setRenderUnavailable] = useState(() => !hasWebGLRenderer())
  const centerMarker = useCallback(() => {
    const runtime = runtimeRef.current
    if (!runtime || !hasCoordinates(latitude, longitude)) return

    const localNormal = latLonVector(latitude, longitude, 1).normalize()
    runtime.world.updateMatrixWorld(true)
    const sceneNormal = localNormal.clone().transformDirection(runtime.world.matrixWorld)
    const worldCenter = runtime.world.getWorldPosition(new Vector3())
    runtime.camera.position
      .copy(worldCenter.clone().add(sceneNormal.multiplyScalar(7.45)).add(new Vector3(0, 0.26, 0)))
    runtime.controls.target.copy(worldCenter)
    runtime.camera.lookAt(worldCenter)
    runtime.controls.update()
  }, [latitude, longitude])

  useEffect(() => {
    if (renderUnavailable) return undefined

    const container = containerRef.current
    if (!container) return undefined

    const scene = new Scene()
    const camera = new PerspectiveCamera(34, 1, 0.1, 50)
    camera.position.set(0, 0.25, 7.8)
    let renderer
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      /*
       * Position selection must remain accessible when a remote desktop,
       * browser policy, or older GPU cannot create a WebGL context.
       */
      const retryTimer = window.setTimeout(() => setRenderUnavailable(true), 0)
      return () => window.clearTimeout(retryTimer)
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.minDistance = 4.65
    controls.maxDistance = 10
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.7
    controls.target.set(0, 0, 0)

    scene.add(new HemisphereLight(0xff8b97, 0x100208, 1.15))
    const keyLight = new PointLight(0xff4259, 22, 16, 2)
    keyLight.position.set(4.2, 3.1, 4.8)
    scene.add(keyLight)
    const edgeLight = new PointLight(0x7b0a21, 12, 13, 2)
    edgeLight.position.set(-4.5, -2.4, -2.8)
    scene.add(edgeLight)

    const world = new Group()
    world.rotation.set(MathUtils.degToRad(-8), MathUtils.degToRad(12), 0)
    scene.add(world)

    const worldTexture = createWorldTexture()
    const globe = new Mesh(
      new SphereGeometry(GLOBE_RADIUS, 88, 56),
      new MeshStandardMaterial({ color: 0x4f0816, map: worldTexture, emissive: 0x25030b, emissiveMap: worldTexture, emissiveIntensity: 0.34, roughness: 0.67, metalness: 0.42 }),
    )
    world.add(globe)

    const atmosphere = new Mesh(
      new SphereGeometry(GLOBE_RADIUS * 1.035, 56, 36),
      new MeshBasicMaterial({ color: 0xff3650, transparent: true, opacity: 0.075, side: BackSide, blending: AdditiveBlending, depthWrite: false }),
    )
    world.add(atmosphere)

    const grid = new Group()
    for (let latitudeLine = -60; latitudeLine <= 60; latitudeLine += 15) {
      const points = []
      for (let longitudeLine = -180; longitudeLine <= 180; longitudeLine += 3) points.push(latLonVector(latitudeLine, longitudeLine, GLOBE_RADIUS + 0.017))
      const major = latitudeLine === 0 || latitudeLine % 30 === 0
      grid.add(createLine(points, major ? 0xff596b : 0x8f1828, major ? 0.28 : 0.09))
    }
    for (let longitudeLine = -180; longitudeLine < 180; longitudeLine += 15) {
      const points = []
      for (let latitudeLine = -90; latitudeLine <= 90; latitudeLine += 3) points.push(latLonVector(latitudeLine, longitudeLine, GLOBE_RADIUS + 0.018))
      const major = longitudeLine % 30 === 0
      grid.add(createLine(points, major ? 0xff596b : 0x8f1828, major ? 0.27 : 0.08))
    }
    world.add(grid)

    const coastlines = new Group()
    LANDMASSES.forEach((landmass) => coastlines.add(createGeoRoute(landmass, GLOBE_RADIUS + 0.032, 0xff8792, 0.88, true)))
    world.add(coastlines)

    const network = new Group()
    GLOBAL_ROUTES.forEach(([from, to]) => network.add(createGeoRoute([GLOBAL_HUBS[from], GLOBAL_HUBS[to]], GLOBE_RADIUS + 0.045, 0xe53449, 0.24)))
    GLOBAL_HUBS.forEach(([longitude, latitude], index) => {
      const hub = new Mesh(new SphereGeometry(index % 4 === 0 ? 0.032 : 0.023, 8, 7), new MeshBasicMaterial({ color: index % 4 === 0 ? 0xff8a96 : 0xff4156, transparent: true, opacity: 0.84, blending: AdditiveBlending, depthWrite: false }))
      hub.position.copy(latLonVector(latitude, longitude, GLOBE_RADIUS + 0.052))
      network.add(hub)
    })
    world.add(network)

    const shell = new LineSegments(
      new WireframeGeometry(new IcosahedronGeometry(GLOBE_RADIUS * 1.03, 2)),
      new LineBasicMaterial({ color: 0x8f1228, transparent: true, opacity: 0.035, depthWrite: false }),
    )
    shell.rotation.set(0.24, 0.48, 0.1)
    world.add(shell)

    const starGeometry = new BufferGeometry()
    const starPositions = []
    for (let index = 0; index < 72; index += 1) {
      const angle = index * 2.399963229728653
      const y = 1 - (index / 71) * 2
      const radial = Math.sqrt(Math.max(0, 1 - y * y))
      const radius = 3.85 + (index % 9) * 0.18
      starPositions.push(radius * radial * Math.cos(angle), radius * y, radius * radial * Math.sin(angle))
    }
    starGeometry.setAttribute('position', new Float32BufferAttribute(starPositions, 3))
    const stars = new Points(starGeometry, new PointsMaterial({ color: 0xb5263b, size: 0.022, transparent: true, opacity: 0.42, depthWrite: false, blending: AdditiveBlending }))
    scene.add(stars)

    const marker = new Group()
    marker.visible = false
    const beam = new Mesh(new CylinderGeometry(0.022, 0.16, 1.7, 18, 1, true), new MeshBasicMaterial({ color: 0xff3d57, transparent: true, opacity: 0.24, side: DoubleSide, depthWrite: false, blending: AdditiveBlending }))
    beam.position.y = 0.86
    marker.add(beam)
    const coreGlow = new Mesh(new SphereGeometry(0.12, 18, 12), new MeshBasicMaterial({ color: 0xff3654, transparent: true, opacity: 0.94, blending: AdditiveBlending, depthWrite: false }))
    coreGlow.position.y = 0.1
    marker.add(coreGlow)
    const rings = [0.105, 0.155, 0.215].map((radius, index) => {
      const ring = new Mesh(new RingGeometry(radius - 0.008, radius, 48), new MeshBasicMaterial({ color: index === 0 ? 0xff8d99 : 0xff3d57, transparent: true, opacity: index === 0 ? 0.96 : 0.66, side: DoubleSide, blending: AdditiveBlending, depthWrite: false }))
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.007
      marker.add(ring)
      return ring
    })
    const markerLight = new PointLight(0xff4260, 6, 3.2, 2)
    markerLight.position.y = 0.46
    marker.add(markerLight)
    const markerTag = createMarkerTag()
    marker.add(markerTag.sprite)
    world.add(marker)

    const resize = () => {
      const width = Math.max(container.clientWidth, 280)
      const height = Math.max(container.clientHeight, 250)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    resize()
    let resizeObserver
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(container)
    } else window.addEventListener('resize', resize)

    let frameId = 0
    const timer = new Timer()
    timer.connect(document)
    const render = () => {
      timer.update()
      const elapsed = timer.getElapsed()
      const reducedMotion = document.documentElement.classList.contains('ultron-reduced-motion')
      if (!reducedMotion) {
        shell.rotation.y += 0.00035
        shell.rotation.z = 0.1 + Math.sin(elapsed * 0.28) * 0.025
        stars.rotation.y -= 0.00016
      }
      if (marker.visible) {
        const wave = reducedMotion ? 0.5 : (Math.sin(elapsed * 3.2) + 1) * 0.5
        rings.forEach((ring, index) => {
          const phase = reducedMotion ? 0.4 + index * 0.08 : (elapsed * (2.3 + index * 0.4) + index * 1.8) % 1
          ring.scale.setScalar(1 + phase * (0.9 + index * 0.36))
          ring.material.opacity = Math.max(0, 0.82 - phase * 0.82)
        })
        coreGlow.scale.setScalar(0.9 + wave * 0.28)
        beam.material.opacity = 0.17 + wave * 0.12
        markerTag.sprite.material.opacity = 0.78 + wave * 0.22
      }
      controls.update()
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(render)
    }
    render()

    world.updateMatrixWorld(true)
    runtimeRef.current = { camera, controls, marker, markerTag, world, lastLocationKey: null }
    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      controls.dispose()
      disposeObject(scene)
      renderer.dispose()
      renderer.forceContextLoss?.()
      renderer.domElement.remove()
      timer.dispose()
      runtimeRef.current = null
    }
  }, [renderUnavailable])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    const valid = hasCoordinates(latitude, longitude)
    runtime.marker.visible = Boolean(active && valid)
    if (!runtime.marker.visible) return

    const key = `${Number(latitude).toFixed(5)}:${Number(longitude).toFixed(5)}:${String(label || '')}`
    const localNormal = latLonVector(latitude, longitude, 1).normalize()
    runtime.marker.position.copy(localNormal.clone().multiplyScalar(GLOBE_RADIUS + MARKER_CLEARANCE))
    runtime.marker.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), localNormal)
    drawMarkerTag(runtime.markerTag, label || 'GLOBAL POSITION')
    if (runtime.lastLocationKey !== key) {
      runtime.lastLocationKey = key
      runtime.world.updateMatrixWorld(true)
      const sceneNormal = localNormal.clone().transformDirection(runtime.world.matrixWorld)
      const worldCenter = runtime.world.getWorldPosition(new Vector3())
      runtime.camera.position.copy(worldCenter.clone().add(sceneNormal.multiplyScalar(7.45)).add(new Vector3(0, 0.26, 0)))
      runtime.controls.target.copy(worldCenter)
      runtime.camera.lookAt(worldCenter)
      runtime.controls.update()
    }
  }, [active, latitude, longitude, label])

  const valid = hasCoordinates(latitude, longitude)
  const displayLabel = valid ? label || `${Number(latitude).toFixed(4)}°, ${Number(longitude).toFixed(4)}°` : 'POSITION UNRESOLVED'
  return (
    <div
      ref={containerRef}
      className={[
        'global-position-globe',
        renderUnavailable ? 'global-position-globe-fallback' : '',
      ].filter(Boolean).join(' ')}
      aria-label={`World position: ${displayLabel}`}
      style={{ position: 'relative', minHeight: 280, width: '100%', overflow: 'hidden' }}
    >
      <div className="global-position-globe-readout global-position-globe-readout-top">
        <span>GLOBAL POSITION</span>
        <strong>{displayLabel}</strong>
      </div>
      {renderUnavailable ? (
        <div className="global-position-fallback-message" role="status">
          <i aria-hidden="true" />
          <strong>MAP VISUALIZER STANDBY</strong>
          <span>
            {valid
              ? 'POSITION SAVED · ' + Number(latitude).toFixed(4) + '°, ' + Number(longitude).toFixed(4) + '°'
              : 'SEARCH FOR A PLACE OR ENTER COORDINATES'}
          </span>
          <p>
            The selected position can still be saved and used for weather.
            This environment does not provide 3D graphics.
          </p>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="global-position-center"
            onClick={centerMarker}
            disabled={!valid}
            aria-label="Center the selected position on the globe"
          >
            CENTER MARKER
          </button>
          <div className="global-position-globe-readout global-position-globe-readout-bottom">
            <i aria-hidden="true" />
            {active && valid ? 'POSITION LOCKED · DRAG TO EXPLORE' : 'SEARCH OR USE YOUR DEVICE POSITION'}
          </div>
        </>
      )}
    </div>
  )
}
