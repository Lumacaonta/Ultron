import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GCodeLoader } from 'three/examples/jsm/loaders/GCodeLoader.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'
import './ModelDeckPage.css'

const SUPPORTED_FORMATS = new Set(['stl', 'obj', '3mf', 'amf', 'ply', 'gcode'])
const MAX_EXTRUSION_SEGMENTS = 240000
const MAX_TRAVEL_SEGMENTS = 42000

function filenameFromPath(path = '') {
  const value = String(path || '')
  return value.split(/[\\/]/).filter(Boolean).pop() || 'UNNAMED_ASSET'
}

function extensionFromPath(path = '') {
  const name = filenameFromPath(path)
  const extension = name.includes('.') ? name.split('.').pop() : ''
  return String(extension || '').toLowerCase()
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDimension(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(number >= 100 ? 0 : 1)} mm` : '—'
}

function formatTriangles(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(number)
}

function formatVolume(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '—'
  if (number >= 1000) return `${(number / 1000).toFixed(1)} cm³`
  return `${number.toFixed(0)} mm³`
}

function responseMessage(payload, fallback) {
  if (typeof payload === 'string') return payload
  return payload?.detail || payload?.error || payload?.message || fallback
}

function normalizeAsset(payload) {
  const source = payload?.asset || payload?.file || payload?.model || payload || {}
  const path = source.path || source.file_path || source.filePath || source.selected_path || ''
  const name = source.name || source.filename || filenameFromPath(path)
  const extension = String(source.extension || source.ext || extensionFromPath(name || path)).replace(/^\./, '').toLowerCase()
  const size = source.size ?? source.bytes ?? source.size_bytes

  if (!path) return null

  return {
    path,
    name,
    extension,
    size: Number.isFinite(Number(size)) ? Number(size) : null,
    modified: source.modified || source.modified_at || source.mtime || null,
  }
}

function isMesh(object) {
  return Boolean(object?.isMesh && object.geometry?.attributes?.position)
}

function isRenderableLine(object) {
  return Boolean(
    (object?.isLine || object?.isLineSegments)
      && object.geometry?.attributes?.position?.count >= 2,
  )
}

function createToolpathRoute(maxSegments) {
  return { points: [], count: 0, stride: 1, maxSegments }
}

function appendToolpathSegment(route, start, end) {
  route.count += 1
  if ((route.count - 1) % route.stride !== 0) return

  // Keep very large slicer exports responsive. Dropping every second segment
  // preserves the overall shape while bounded memory keeps the browser alive.
  route.points.push(start.x, start.z, -start.y, end.x, end.z, -end.y)
  if (route.points.length / 6 <= route.maxSegments) return

  const compacted = []
  for (let offset = 0; offset < route.points.length; offset += 12) {
    compacted.push(
      route.points[offset], route.points[offset + 1], route.points[offset + 2],
      route.points[offset + 3], route.points[offset + 4], route.points[offset + 5],
    )
  }
  route.points = compacted
  route.stride *= 2
}

/**
 * GCodeLoader is useful for conventional files, but slicers often emit compact
 * commands, mixed whitespace, or comments that make a preview appear empty.
 * This path reader accepts those variants and turns each motion into explicit
 * line segments, retaining extrusion and travel routes separately.
 */
function buildGcodeToolpathModel(source) {
  const extrusion = createToolpathRoute(MAX_EXTRUSION_SEGMENTS)
  const travel = createToolpathRoute(MAX_TRAVEL_SEGMENTS)
  const state = { x: 0, y: 0, z: 0, e: 0, relative: false, extrusionRelative: false }

  String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim()
    if (!line) return

    const command = line.match(/^\s*([GMT])\s*(\d+(?:\.\d+)?)/i)
    if (!command) return

    const family = command[1].toUpperCase()
    const code = Number(command[2])
    const args = {}
    const parameterPattern = /([XYZEFR])\s*([-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[-+]?\d+)?)/ig
    let match = parameterPattern.exec(line)
    while (match) {
      const value = Number(match[2])
      if (Number.isFinite(value)) args[match[1].toLowerCase()] = value
      match = parameterPattern.exec(line)
    }

    if (family === 'G' && code === 90) {
      state.relative = false
      return
    }
    if (family === 'G' && code === 91) {
      state.relative = true
      return
    }
    if (family === 'M' && code === 82) {
      state.extrusionRelative = false
      return
    }
    if (family === 'M' && code === 83) {
      state.extrusionRelative = true
      return
    }
    if (family === 'G' && code === 92) {
      ;['x', 'y', 'z', 'e'].forEach((axis) => {
        if (args[axis] !== undefined) state[axis] = args[axis]
      })
      return
    }
    if (family !== 'G' || (code !== 0 && code !== 1)) return

    const next = { ...state }
    ;['x', 'y', 'z'].forEach((axis) => {
      if (args[axis] !== undefined) next[axis] = state.relative ? state[axis] + args[axis] : args[axis]
    })

    let extrusionDelta = 0
    if (args.e !== undefined) {
      next.e = state.extrusionRelative ? state.e + args.e : args.e
      extrusionDelta = next.e - state.e
    }

    const moved = Math.hypot(next.x - state.x, next.y - state.y, next.z - state.z) > 0.00001
    if (moved) appendToolpathSegment(extrusionDelta > 0.000001 ? extrusion : travel, state, next)

    state.x = next.x
    state.y = next.y
    state.z = next.z
    state.e = next.e
  })

  if (extrusion.points.length < 6 && travel.points.length < 6) return null

  const root = new THREE.Group()
  root.name = 'gcode-toolpath'
  root.userData.gcodeToolpath = true
  root.userData.toolpathSegments = extrusion.count + travel.count

  const addRoute = (route, kind) => {
    if (route.points.length < 6) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(route.points, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const line = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: kind === 'extrusion' ? 0xff4b5a : 0x91202a,
        transparent: true,
        opacity: kind === 'extrusion' ? 0.94 : 0.28,
        toneMapped: false,
      }),
    )
    line.name = `gcode-${kind}-route`
    line.frustumCulled = false
    line.userData.gcodeToolpath = true
    line.userData.toolpathKind = kind
    line.userData.toolpathSegments = route.count
    root.add(line)
  }

  // Extrusion is the useful fabrication shape. Travel stays as a dim context
  // layer so a file without E values still has a usable preview.
  addRoute(extrusion, 'extrusion')
  addRoute(travel, 'travel')
  return root
}

function getSegmentPositions(line) {
  const position = line.geometry?.attributes?.position
  if (!position || position.count < 2) return null

  if (line.isLineSegments) return Array.from(position.array.slice(0, position.count * position.itemSize))

  const segments = []
  for (let index = 0; index < position.count - 1; index += 1) {
    segments.push(
      position.getX(index), position.getY(index), position.getZ(index),
      position.getX(index + 1), position.getY(index + 1), position.getZ(index + 1),
    )
  }
  if (line.isLineLoop) {
    const last = position.count - 1
    segments.push(
      position.getX(last), position.getY(last), position.getZ(last),
      position.getX(0), position.getY(0), position.getZ(0),
    )
  }
  return segments
}

function updateWideLineResolution(root, width, height) {
  root?.traverse?.((part) => {
    const materials = Array.isArray(part.material) ? part.material : [part.material]
    materials.filter((material) => material?.isLineMaterial).forEach((material) => {
      material.resolution.set(width, height)
    })
  })
}

function estimateModelStats(model) {
  const bounds = new THREE.Box3().setFromObject(model)
  const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3())
  let triangles = 0
  let signedVolume = 0
  let toolpathSegments = 0

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const cross = new THREE.Vector3()

  model.updateMatrixWorld(true)
  model.traverse((part) => {
    if (isRenderableLine(part)) {
      const position = part.geometry.attributes.position
      const segments = part.isLineSegments ? Math.floor(position.count / 2) : Math.max(0, position.count - 1)
      toolpathSegments += Number(part.userData?.toolpathSegments) || segments
      return
    }
    if (!isMesh(part)) return

    const geometry = part.geometry
    const position = geometry.attributes.position
    const index = geometry.index
    const triangleCount = Math.floor((index ? index.count : position.count) / 3)
    triangles += triangleCount

    // Avoid pausing the control deck on very dense scans. The volume remains an
    // estimate and is explicitly labelled as such in the interface.
    const maximumSamples = 240000
    const sampleEvery = Math.max(1, Math.ceil(triangleCount / maximumSamples))
    let sampled = 0
    let localSignedVolume = 0

    for (let face = 0; face < triangleCount; face += sampleEvery) {
      const offset = face * 3
      const ia = index ? index.getX(offset) : offset
      const ib = index ? index.getX(offset + 1) : offset + 1
      const ic = index ? index.getX(offset + 2) : offset + 2
      a.fromBufferAttribute(position, ia).applyMatrix4(part.matrixWorld)
      b.fromBufferAttribute(position, ib).applyMatrix4(part.matrixWorld)
      c.fromBufferAttribute(position, ic).applyMatrix4(part.matrixWorld)
      localSignedVolume += a.dot(cross.copy(b).cross(c)) / 6
      sampled += 1
    }

    if (sampled) signedVolume += Math.abs(localSignedVolume) * (triangleCount / sampled)
  })

  return {
    bounds: [size.x, size.y, size.z],
    triangles,
    volume: signedVolume,
    toolpathSegments,
  }
}

function parseModel(extension, arrayBuffer) {
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(arrayBuffer)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  }

  if (extension === 'obj') {
    return new OBJLoader().parse(new TextDecoder().decode(arrayBuffer))
  }

  if (extension === '3mf') {
    return new ThreeMFLoader().parse(arrayBuffer)
  }

  if (extension === 'amf') {
    return new AMFLoader().parse(arrayBuffer)
  }

  if (extension === 'ply') {
    const geometry = new PLYLoader().parse(arrayBuffer)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  }

  if (extension === 'gcode') {
    const source = new TextDecoder().decode(arrayBuffer)
    const toolpath = buildGcodeToolpathModel(source)
    if (toolpath) return toolpath

    // Preserve the official loader as a final compatibility path for a G-code
    // dialect the local fallback cannot identify.
    const loaded = new GCodeLoader().parse(source)
    loaded.userData.gcodeToolpath = true
    return loaded
  }

  throw new Error(`Unsupported format: .${extension || 'unknown'}`)
}

function disposeObject(root) {
  root?.traverse?.((part) => {
    if (part.geometry?.dispose) part.geometry.dispose()
    const materials = Array.isArray(part.material) ? part.material : [part.material]
    materials.filter(Boolean).forEach((material) => material.dispose?.())
  })
}

function makePreviewModel(source) {
  const root = source.clone(true)
  root.traverse((part) => {
    if (part.userData?.previewWideLine) return
    if (!isMesh(part)) return
    part.geometry = part.geometry.clone()
    part.geometry.computeVertexNormals()
    part.material = new THREE.MeshPhysicalMaterial({
      color: 0x4b050b,
      emissive: 0x220005,
      emissiveIntensity: 0.66,
      metalness: 0.7,
      roughness: 0.24,
      clearcoat: 0.7,
      clearcoatRoughness: 0.16,
    })
    part.castShadow = true
    part.receiveShadow = true

    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(part.geometry),
      new THREE.LineBasicMaterial({ color: 0xff4b54, transparent: true, opacity: 0.19 }),
    )
    wire.userData.previewWire = true
    part.add(wire)
  })

  root.traverse((part) => {
    if (!isRenderableLine(part)) return

    const segments = getSegmentPositions(part)
    if (!segments?.length) return
    const kind = part.userData?.toolpathKind || part.material?.name
    const travelRoute = kind === 'travel' || kind === 'path'
    const segmentCount = Math.floor(segments.length / 6)

    // Clone before disposal: closing a renderer instance must never invalidate
    // the source model used by a reset or a subsequent effect.
    part.geometry = part.geometry.clone()
    // Keep a normal WebGL line route as the guaranteed visible layer. Large
    // Cura jobs can contain hundreds of thousands of moves and some Electron
    // GPUs silently drop the wide-line shader used for the glow overlay.
    part.material = new THREE.LineBasicMaterial({
      color: travelRoute ? 0x8a1d28 : 0xff6570,
      transparent: true,
      opacity: travelRoute ? 0.26 : 0.9,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    part.frustumCulled = false
    part.renderOrder = 2

    // The bright wide-line overlay is useful on small assets. Above this
    // threshold the normal route remains visible without exhausting the
    // renderer on a high-density sliced file.
    if (segmentCount > 48000) return

    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(segments)
    const material = new LineMaterial({
      color: travelRoute ? 0x8a1d28 : 0xff5968,
      linewidth: travelRoute ? 0.75 : 2.1,
      transparent: true,
      opacity: travelRoute ? 0.34 : 1,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    material.resolution.set(1, 1)

    const visibleRoute = new LineSegments2(geometry, material)
    visibleRoute.name = 'visible-toolpath-route'
    visibleRoute.frustumCulled = false
    visibleRoute.renderOrder = 3
    visibleRoute.userData.previewWideLine = true
    part.add(visibleRoute)
  })

  const bounds = new THREE.Box3().setFromObject(root)
  const center = bounds.getCenter(new THREE.Vector3())
  const size = bounds.getSize(new THREE.Vector3())
  const largestAxis = Math.max(size.x, size.y, size.z, 1)
  // Object3D applies its scale to children before adding its position.  The
  // previous version subtracted the unscaled millimetre-space center here,
  // which put common 150 mm G-code jobs dozens of scene units off camera
  // after their geometry had been reduced to the 3.65-unit inspection bay.
  // Translate by the scaled center so the preview stays at the optical origin.
  const previewScale = 3.65 / largestAxis
  root.scale.setScalar(previewScale)
  root.position.copy(center).multiplyScalar(-previewScale)
  root.updateMatrixWorld(true)
  return root
}

function ModelViewport({ model, loading, resetToken }) {
  const mountRef = useRef(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x050306, 0.085)
    const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 80)
    camera.position.set(5.5, 3.6, 8.2)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x050306, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.28
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.enablePan = false
    controls.minDistance = 4.4
    controls.maxDistance = 18
    controls.autoRotate = Boolean(model)
    controls.autoRotateSpeed = 0.42

    const ambient = new THREE.HemisphereLight(0xffa9ad, 0x110006, 1.25)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xff4752, 4.7)
    key.position.set(5, 7, 5)
    key.castShadow = true
    scene.add(key)
    const rim = new THREE.PointLight(0xff1231, 48, 20, 2)
    rim.position.set(-5, 1, -4)
    scene.add(rim)
    const scanner = new THREE.PointLight(0xff8991, 18, 12, 2)
    scanner.position.set(0, -3, 3)
    scene.add(scanner)

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(5.65, 96),
      new THREE.MeshStandardMaterial({ color: 0x120207, metalness: 0.72, roughness: 0.46, transparent: true, opacity: 0.92 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -2.42
    floor.receiveShadow = true
    scene.add(floor)

    const grid = new THREE.GridHelper(10.4, 24, 0xe41a2b, 0x551019)
    grid.position.y = -2.4
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
    gridMaterials.forEach((material) => {
      material.transparent = true
      material.opacity = 0.48
    })
    scene.add(grid)

    const rings = new THREE.Group()
    ;[2.35, 3.35, 4.5].forEach((radius, index) => {
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          Array.from({ length: 96 }, (_, step) => {
            const angle = (step / 96) * Math.PI * 2
            return new THREE.Vector3(Math.cos(angle) * radius, -2.37 + index * 0.006, Math.sin(angle) * radius)
          }),
        ),
        new THREE.LineBasicMaterial({ color: index === 0 ? 0xff6a70 : 0x941420, transparent: true, opacity: index === 0 ? 0.48 : 0.23 }),
      )
      rings.add(ring)
    })
    scene.add(rings)

    let preview = null
    if (model) {
      preview = makePreviewModel(model)
      scene.add(preview)
    }

    const resize = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      updateWideLineResolution(preview, width, height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()

    let frame = 0
    const startedAt = performance.now()
    const render = (now) => {
      const elapsed = (now - startedAt) / 1000
      rings.rotation.y = elapsed * 0.1
      rings.rotation.z = Math.sin(elapsed * 0.35) * 0.025
      scanner.intensity = 15 + Math.sin(elapsed * 2.2) * 4
      controls.update()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      if (preview) disposeObject(preview)
      floor.geometry.dispose()
      floor.material.dispose()
      grid.geometry.dispose()
      gridMaterials.forEach((material) => material.dispose())
      rings.traverse((part) => {
        part.geometry?.dispose?.()
        part.material?.dispose?.()
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [model, resetToken])

  return (
    <div className="model-deck-viewport" ref={mountRef}>
      <div className="model-deck-viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
      {!model && !loading && (
        <div className="model-deck-empty-state">
          <span>FABRICATION ASSET BAY</span>
          <strong>AWAITING MODEL</strong>
          <small>SELECT STL, OBJ, 3MF, AMF, PLY OR G-CODE TO INITIALIZE THE PREVIEW.</small>
        </div>
      )}
      {loading && <div className="model-deck-loading">DECODING GEOMETRY<span /></div>}
    </div>
  )
}

function Metric({ label, value, detail, active = false }) {
  return (
    <article className="model-deck-metric" data-active={active ? 'true' : 'false'}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </article>
  )
}

function ActionButton({ children, disabled, onClick, tone = 'secondary', title }) {
  return (
    <button
      type="button"
      className={`model-deck-action model-deck-action-${tone}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}

/**
 * Isolated fabrication console. The parent decides where the page appears and
 * may provide native Cura launching through `onOpenCura`; all file work stays
 * on the local backend so browser code never receives arbitrary filesystem APIs.
 */
export default function ModelDeckPage({
  onBack,
  onOpenCura,
  backendOnline = false,
  printerStatus = null,
}) {
  const [asset, setAsset] = useState(null)
  const [model, setModel] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState('')
  const [notice, setNotice] = useState('SELECT A FABRICATION ASSET TO BEGIN')
  const [error, setError] = useState('')
  const [resetToken, setResetToken] = useState(0)

  useEffect(() => () => disposeObject(model), [model])

  const printerOnline = Boolean(printerStatus?.connected)
  const printerState = printerStatus?.status || (printerOnline ? 'LINKED' : 'STANDBY')
  const canSelect = Boolean(backendOnline) && !loading

  const selectAsset = useCallback(async () => {
    if (!backendOnline || loading) return
    setLoading(true)
    setError('')
    setNotice('OPENING LOCAL ASSET SELECTOR…')

    try {
      let response = await fetch(`${BACKEND}/api/models/pick`, { method: 'POST' })
      if (response.status === 405) response = await fetch(`${BACKEND}/api/models/pick`)
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(responseMessage(payload, 'The local file selector is unavailable.'))
      if (payload?.cancelled || payload?.canceled) {
        setNotice('ASSET SELECTION CANCELLED')
        return
      }

      const nextAsset = normalizeAsset(payload)
      if (!nextAsset) throw new Error('No model file was returned by the selector.')
      if (!SUPPORTED_FORMATS.has(nextAsset.extension)) {
        throw new Error(`.${nextAsset.extension || 'unknown'} IS NOT A SUPPORTED FORMAT.`)
      }

      setNotice(`READING ${nextAsset.name.toUpperCase()}…`)
      const content = await fetch(`${BACKEND}/api/models/file?path=${encodeURIComponent(nextAsset.path)}`)
      if (!content.ok) {
        const contentPayload = await content.json().catch(() => null)
        throw new Error(responseMessage(contentPayload, 'ULTRON could not read the selected model.'))
      }
      const buffer = await content.arrayBuffer()
      const parsed = parseModel(nextAsset.extension, buffer)
      const nextStats = estimateModelStats(parsed)

      setModel(parsed)
      setAsset({ ...nextAsset, size: nextAsset.size ?? buffer.byteLength })
      setStats(nextStats)
      setResetToken(token => token + 1)
      setNotice('GEOMETRY VERIFIED // READY FOR FABRICATION')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The model could not be decoded.'
      setError(message)
      setNotice('ASSET ACQUISITION INTERRUPTED')
    } finally {
      setLoading(false)
    }
  }, [backendOnline, loading])

  const launchCura = useCallback(async () => {
    if (!asset || actionLoading) return
    setActionLoading('cura')
    setError('')
    try {
      if (typeof onOpenCura === 'function') {
        const result = await onOpenCura(asset.path, asset)
        if (result === false || result?.ok === false) throw new Error(responseMessage(result, 'Ultimaker Cura did not accept the model.'))
      } else {
        const response = await fetch(`${BACKEND}/api/models/open-cura`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: asset.path }),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, 'Ultimaker Cura could not be opened.'))
      }
      setNotice('CURA LAUNCH SIGNAL ISSUED // MODEL TRANSFERRED')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ultimaker Cura could not be opened.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, asset, onOpenCura])

  const revealAsset = useCallback(async () => {
    if (!asset || actionLoading) return
    setActionLoading('reveal')
    setError('')
    try {
      const response = await fetch(`${BACKEND}/api/models/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: asset.path }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, 'Finder could not reveal the model.'))
      setNotice('FINDER LOCATION REVEALED')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Finder could not reveal the model.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, asset])

  const metrics = useMemo(() => [
    { label: 'FORMAT', value: asset ? `.${asset.extension.toUpperCase()}` : '—', detail: asset ? 'VALIDATED INPUT' : 'NO ASSET' },
    asset?.extension === 'gcode'
      ? { label: 'PATH SEGMENTS', value: formatTriangles(stats?.toolpathSegments), detail: stats?.toolpathSegments ? 'FABRICATION ROUTES' : 'AWAITING ROUTES' }
      : { label: 'TRIANGLES', value: formatTriangles(stats?.triangles), detail: stats?.triangles ? 'SURFACE MESH' : 'AWAITING SCAN' },
    { label: 'BUILD VOLUME', value: formatVolume(stats?.volume), detail: 'ESTIMATED SOLID' },
    { label: 'FILE SIZE', value: formatBytes(asset?.size), detail: 'LOCAL STORAGE' },
  ], [asset, stats])

  return (
    <section className="model-deck" aria-label="ULTRON fabrication model deck">
      <div className="model-deck-grid" aria-hidden="true" />
      <header className="model-deck-header">
        <div className="model-deck-title-group">
          <button type="button" className="model-deck-back" onClick={onBack} title="Return to device command">
            <span>←</span> DEVICE CONTROL
          </button>
          <div>
            <span>FABRICATION COMMAND // MODEL ACQUISITION</span>
            <h1>MODEL DECK</h1>
          </div>
        </div>
        <div className="model-deck-header-status">
          <div data-online={backendOnline ? 'true' : 'false'}><i /> {backendOnline ? 'CORE LINK LIVE' : 'CORE LINK OFFLINE'}</div>
          <div data-online={printerOnline ? 'true' : 'false'}><i /> PRINTER {printerOnline ? 'LINKED' : 'STANDBY'}</div>
        </div>
      </header>

      <main className="model-deck-main">
        <section className="model-deck-hero">
          <div className="model-deck-hero-head">
            <div>
              <span>ASSET VISUALIZATION BAY</span>
              <strong>{asset?.name || 'NO GEOMETRY LOADED'}</strong>
            </div>
            <button
              type="button"
              className="model-deck-reset-view"
              onClick={() => setResetToken(token => token + 1)}
              disabled={!model}
            >
              RESET OPTICS
            </button>
          </div>
          <ModelViewport model={model} loading={loading} resetToken={resetToken} />
          <div className="model-deck-hero-footer">
            <span>ROTATE // INSPECT // ZOOM</span>
            <span>{model ? 'MESH INTEGRITY: NOMINAL' : 'MESH INTEGRITY: AWAITING INPUT'}</span>
          </div>
        </section>

        <aside className="model-deck-analysis">
          <section className="model-deck-status-panel">
            <div className="model-deck-section-title"><span>FABRICATION CELL</span><b>02</b></div>
            <div className="model-deck-printer-glyph" data-online={printerOnline ? 'true' : 'false'} aria-hidden="true">
              <span /><span /><span /><i />
            </div>
            <div className="model-deck-printer-readout">
              <strong>3D PRINTER</strong>
              <span>{printerState}</span>
              <small>{printerStatus?.port || 'USB AUTO DETECTION // LOCAL CELL'}</small>
            </div>
          </section>

          <section className="model-deck-metrics-panel">
            <div className="model-deck-section-title"><span>GEOMETRY TELEMETRY</span><b>LIVE</b></div>
            <div className="model-deck-metrics">
              {metrics.map(metric => <Metric key={metric.label} {...metric} active={Boolean(asset)} />)}
            </div>
          </section>

          <section className="model-deck-bounds-panel">
            <div className="model-deck-section-title"><span>ENVELOPE DIMENSIONS</span><b>XYZ</b></div>
            <div className="model-deck-bounds-diagram" aria-hidden="true"><i /><i /><i /></div>
            <dl>
              <div><dt>X AXIS</dt><dd>{formatDimension(stats?.bounds?.[0])}</dd></div>
              <div><dt>Y AXIS</dt><dd>{formatDimension(stats?.bounds?.[1])}</dd></div>
              <div><dt>Z AXIS</dt><dd>{formatDimension(stats?.bounds?.[2])}</dd></div>
            </dl>
          </section>
        </aside>
      </main>

      <footer className="model-deck-command-bar">
        <div className="model-deck-command-message" data-error={error ? 'true' : 'false'}>
          <i />
          <span>{error || notice}</span>
        </div>
        <div className="model-deck-actions">
          <ActionButton onClick={selectAsset} disabled={!canSelect} tone="primary" title={backendOnline ? 'Select a local STL, OBJ, 3MF, AMF, PLY or G-code file' : 'Connect to the local ULTRON Core first'}>
            {loading ? 'READING ASSET…' : 'SELECT ASSET'}
          </ActionButton>
          <ActionButton onClick={launchCura} disabled={!asset || Boolean(actionLoading)} tone="danger" title="Open this asset in Ultimaker Cura">
            {actionLoading === 'cura' ? 'OPENING CURA…' : 'OPEN IN CURA'}
          </ActionButton>
          <ActionButton onClick={revealAsset} disabled={!asset || Boolean(actionLoading)} title="Reveal this asset in Finder">
            {actionLoading === 'reveal' ? 'REVEALING…' : 'REVEAL IN FINDER'}
          </ActionButton>
        </div>
      </footer>
    </section>
  )
}
