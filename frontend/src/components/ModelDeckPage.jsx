import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping,
  Box3,
  BufferGeometry,
  CircleGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PointLight,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
  WireframeGeometry
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GCodeLoader } from 'three/examples/jsm/loaders/GCodeLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { BACKEND_ORIGIN as BACKEND } from '../auth.js'
import './ModelDeckPage.css'

/*
 * The Core owns the final allow-list because it controls the native picker and
 * the bounded file endpoint.  This registry only describes what this browser
 * build can render itself.  A format returned by the Core must never disappear
 * merely because Three.js has no safe local decoder for it.
 */
const RENDERABLE_FORMATS = new Set([
  'stl', 'obj', '3mf', 'amf', 'ply', 'gcode', 'gco', 'g', 'gc', 'nc', 'tap', 'glb', 'gltf',
])

const FORMAT_FAMILIES = [
  {
    label: 'LIVE INSPECTION',
    detail: 'Interactive local preview',
    formats: ['STL', 'OBJ', '3MF', 'AMF', 'PLY', 'GLB', 'GLTF', 'G-CODE'],
  },
  {
    label: 'CAD / PROJECT',
    detail: 'Catalogued, then hand off to a selected app',
    formats: ['STEP', 'IGES', 'F3D', 'FCSTD', 'SKP', 'SLDPRT', 'DWG', 'DXF'],
  },
  {
    label: 'SLICER / MACHINE',
    detail: 'Catalogued with file facts and safe app handoff',
    formats: ['GCO', 'BGCODE', 'X3G', 'CTB', 'PHZ', 'UVTOOLS', 'PROJECT'],
  },
]
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

function hasWebGLRenderer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false

  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function ModelDeckPreviewUnavailable({ asset, detail }) {
  return (
    <div className="model-deck-viewport model-deck-renderer-fallback" role="status" aria-live="polite">
      <div className="model-deck-viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="model-deck-empty-state">
        <span>LOCAL VISUALIZATION CONTINUES</span>
        <strong>3D PREVIEW STANDBY</strong>
        <small>{detail || (asset
          ? 'This file is catalogued. Its details, selected software and safe handoff controls remain available.'
          : 'Select a file to catalogue it and open it with a compatible local application.')}</small>
      </div>
    </div>
  )
}

class ModelDeckPreviewBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onRendererUnavailable?.()
  }

  render() {
    if (this.state.failed) {
      return <ModelDeckPreviewUnavailable asset={this.props.asset} detail="The 3D preview could not start here. Your file catalogue and handoff controls are still ready." />
    }

    return this.props.children
  }
}

function responseMessage(payload, fallback) {
  if (typeof payload === 'string') return payload
  return payload?.detail || payload?.error || payload?.message || fallback
}

function desktopBridge() {
  if (typeof window === 'undefined') return null
  const bridge = window.ultronDesktop
  if (
    !bridge ||
    typeof bridge.selectModel !== 'function' ||
    typeof bridge.selectExternalApp !== 'function'
  ) {
    return null
  }
  return bridge
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
    format: source.format || source.format_name || extension.toUpperCase(),
    mediaType: source.mediaType || source.media_type || '',
    telemetry: source.telemetry && typeof source.telemetry === 'object' ? source.telemetry : null,
    preview: source.preview && typeof source.preview === 'object' ? source.preview : null,
  }
}

function previewCapability(asset) {
  if (!asset) return { mode: 'empty', reason: '' }

  const localParserAvailable = RENDERABLE_FORMATS.has(asset.extension)
  const declaredSupported = asset.preview?.supported

  if (declaredSupported === false) {
    return {
      mode: 'metadata',
      reason: asset.preview?.reason || 'This file is catalogued locally and can be handed to compatible software.',
    }
  }

  if (!localParserAvailable) {
    return {
      mode: 'metadata',
      reason: asset.preview?.reason || 'This format is available in the catalog. Open it in a selected application for its native view.',
    }
  }

  return { mode: 'render', reason: '' }
}

function normalizeExternalApp(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || value.path || value.name || '').trim()
  const name = String(value.name || value.label || value.id || 'External application').trim()
  if (!id || !name) return null

  return {
    id,
    name,
    kind: String(value.kind || 'External application'),
    available: value.available !== false,
    configured: value.configured !== false,
    launchesFiles: value.launchesFiles !== false,
    supports: Array.isArray(value.supports) ? value.supports.filter(Boolean).map(item => String(item).toUpperCase()) : [],
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

  const root = new Group()
  root.name = 'gcode-toolpath'
  root.userData.gcodeToolpath = true
  root.userData.toolpathSegments = extrusion.count + travel.count

  const addRoute = (route, kind) => {
    if (route.points.length < 6) return
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(route.points, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    const line = new LineSegments(
      geometry,
      new LineBasicMaterial({
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
  const bounds = new Box3().setFromObject(model)
  const size = bounds.isEmpty() ? new Vector3() : bounds.getSize(new Vector3())
  let triangles = 0
  let signedVolume = 0
  let toolpathSegments = 0

  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const cross = new Vector3()

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

async function parseModel(extension, arrayBuffer) {
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(arrayBuffer)
    geometry.computeVertexNormals()
    return new Mesh(geometry, new MeshStandardMaterial())
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
    return new Mesh(geometry, new MeshStandardMaterial())
  }

  if (['gcode', 'gco', 'g', 'gc', 'nc', 'tap'].includes(extension)) {
    const source = new TextDecoder().decode(arrayBuffer)
    const toolpath = buildGcodeToolpathModel(source)
    if (toolpath) return toolpath

    // Preserve the official loader as a final compatibility path for a G-code
    // dialect the local fallback cannot identify.
    const loaded = new GCodeLoader().parse(source)
    loaded.userData.gcodeToolpath = true
    return loaded
  }

  if (extension === 'glb' || extension === 'gltf') {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader()
      loader.parse(
        arrayBuffer,
        '',
        result => resolve(result.scene || result.scenes?.[0] || new Group()),
        reject,
      )
    })
  }

  throw new Error(`This build does not include a local renderer for .${extension || 'unknown'}.`)
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
    part.material = new MeshPhysicalMaterial({
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

    const wire = new LineSegments(
      new WireframeGeometry(part.geometry),
      new LineBasicMaterial({ color: 0xff4b54, transparent: true, opacity: 0.19 }),
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
    part.material = new LineBasicMaterial({
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

  const bounds = new Box3().setFromObject(root)
  const center = bounds.getCenter(new Vector3())
  const size = bounds.getSize(new Vector3())
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

function ModelViewport({ model, asset, loading, preview, resetToken, rendererAvailable, onRendererUnavailable }) {
  const mountRef = useRef(null)

  useEffect(() => {
    if (!rendererAvailable) return undefined

    const mount = mountRef.current
    if (!mount) return undefined

    let renderer
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      window.setTimeout(() => onRendererUnavailable?.(), 0)
      return undefined
    }

    const scene = new Scene()
    scene.fog = new FogExp2(0x050306, 0.085)
    const camera = new PerspectiveCamera(33, 1, 0.1, 80)
    camera.position.set(5.5, 3.6, 8.2)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x050306, 0)
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.28
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFSoftShadowMap
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

    const ambient = new HemisphereLight(0xffa9ad, 0x110006, 1.25)
    scene.add(ambient)
    const key = new DirectionalLight(0xff4752, 4.7)
    key.position.set(5, 7, 5)
    key.castShadow = true
    scene.add(key)
    const rim = new PointLight(0xff1231, 48, 20, 2)
    rim.position.set(-5, 1, -4)
    scene.add(rim)
    const scanner = new PointLight(0xff8991, 18, 12, 2)
    scanner.position.set(0, -3, 3)
    scene.add(scanner)

    const floor = new Mesh(
      new CircleGeometry(5.65, 96),
      new MeshStandardMaterial({ color: 0x120207, metalness: 0.72, roughness: 0.46, transparent: true, opacity: 0.92 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -2.42
    floor.receiveShadow = true
    scene.add(floor)

    const grid = new GridHelper(10.4, 24, 0xe41a2b, 0x551019)
    grid.position.y = -2.4
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material]
    gridMaterials.forEach((material) => {
      material.transparent = true
      material.opacity = 0.48
    })
    scene.add(grid)

    const rings = new Group()
    ;[2.35, 3.35, 4.5].forEach((radius, index) => {
      const ring = new LineLoop(
        new BufferGeometry().setFromPoints(
          Array.from({ length: 96 }, (_, step) => {
            const angle = (step / 96) * Math.PI * 2
            return new Vector3(Math.cos(angle) * radius, -2.37 + index * 0.006, Math.sin(angle) * radius)
          }),
        ),
        new LineBasicMaterial({ color: index === 0 ? 0xff6a70 : 0x941420, transparent: true, opacity: index === 0 ? 0.48 : 0.23 }),
      )
      rings.add(ring)
    })
    scene.add(rings)

    let previewModel = null
    if (model) {
      previewModel = makePreviewModel(model)
      scene.add(previewModel)
    }

    const resize = () => {
      const width = Math.max(1, mount.clientWidth)
      const height = Math.max(1, mount.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      updateWideLineResolution(previewModel, width, height)
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
      if (previewModel) disposeObject(previewModel)
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
  }, [model, onRendererUnavailable, rendererAvailable, resetToken])

  if (!rendererAvailable) {
    return <ModelDeckPreviewUnavailable asset={asset} />
  }

  return (
    <div className="model-deck-viewport" ref={mountRef}>
      <div className="model-deck-viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
      {!model && !loading && (
        <div className="model-deck-empty-state">
          <span>{asset ? 'LOCAL ASSET CATALOGUE' : 'FABRICATION ASSET BAY'}</span>
          <strong>{asset ? 'METADATA VIEW ACTIVE' : 'AWAITING MODEL'}</strong>
          <small>
            {asset
              ? preview?.reason || 'This file is ready for a compatible local application.'
              : 'SELECT A MODEL OR TOOLPATH TO INITIALIZE LOCAL INSPECTION.'}
          </small>
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

function FabricationPrinterVisual({ online }) {
  return (
    <div className="model-deck-printer-visual" data-online={online ? 'true' : 'false'} aria-hidden="true">
      {online ? (
        <svg viewBox="0 0 240 128" focusable="false">
          <g className="model-deck-printer-visual-grid" fill="none">
            <path d="M18 103h204M35 116h170M57 126h126" />
            <path d="M42 103l17 23M75 103l11 23M108 103l4 23M132 103l-4 23M165 103l-11 23M198 103l-17 23" />
          </g>
          <g className="model-deck-printer-visual-halo" fill="none">
            <ellipse cx="120" cy="62" rx="74" ry="51" />
            <path d="M120 7v16M120 104v17M47 62h15M178 62h15" />
          </g>
          <g className="model-deck-printer-visual-frame" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M69 27v70M171 27v70M69 27h102M69 97h102" />
            <path d="M77 34h86v8H77z" />
            <path d="M78 42h84M78 83h84" />
            <path d="M83 85h74l10 12H73z" />
            <path d="M101 44h38v27h-38z" />
            <path d="M120 35v52" />
            <path d="M111 58h18v13h-18zM115 71h10l-2 9h-6z" />
          </g>
          <g className="model-deck-printer-visual-build">
            <path d="M106 84l5-9h18l5 9z" />
            <path d="M110 80h20" />
          </g>
          <g className="model-deck-printer-visual-signal" fill="none">
            <circle cx="120" cy="64" r="9" />
            <circle cx="120" cy="64" r="19" />
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 240 128" focusable="false">
          <g className="model-deck-printer-visual-grid" fill="none">
            <path d="M22 103h196M43 116h154M66 126h108" />
            <path d="M43 103l18 23M77 103l11 23M111 103l4 23M129 103l-4 23M163 103l-11 23M197 103l-18 23" />
          </g>
          <g className="model-deck-printer-visual-empty-orbit" fill="none">
            <circle cx="120" cy="63" r="43" />
            <circle cx="120" cy="63" r="56" />
          </g>
          <g className="model-deck-printer-visual-empty-core" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M120 31l29 16v33l-29 17-29-17V47z" />
            <path d="M91 47l29 17 29-17M120 64v33" />
            <path d="M104 70h32M104 78h32" />
            <circle cx="120" cy="63" r="3.2" />
          </g>
        </svg>
      )}
    </div>
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

function FormatCatalogue() {
  return (
    <section className="model-deck-format-panel" aria-label="Supported fabrication file families">
      <div className="model-deck-section-title"><span>ASSET CATALOGUE</span><b>LOCAL</b></div>
      <p>Files remain visible even when their native preview belongs to a CAD or slicer application.</p>
      <div className="model-deck-format-groups">
        {FORMAT_FAMILIES.map(group => (
          <div className="model-deck-format-group" key={group.label}>
            <div><strong>{group.label}</strong><small>{group.detail}</small></div>
            <ul>
              {group.formats.map(format => <li key={format}>{format}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

function AssetPreviewState({ asset, model, preview, rendererAvailable }) {
  if (!asset) return 'AWAITING INPUT'
  if (model && rendererAvailable) return 'LIVE PREVIEW READY'
  if (preview?.mode === 'failed') return 'PREVIEW UNAVAILABLE'
  return 'METADATA VIEW ACTIVE'
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
  const [preview, setPreview] = useState({ mode: 'empty', reason: '' })
  const [rendererAvailable, setRendererAvailable] = useState(() => hasWebGLRenderer())
  const [externalApps, setExternalApps] = useState([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsError, setAppsError] = useState('')
  const [selectedAppId, setSelectedAppId] = useState('')
  const [softwareLabel, setSoftwareLabel] = useState('')
  const markRendererUnavailable = useCallback(() => setRendererAvailable(false), [])

  useEffect(() => () => disposeObject(model), [model])

  const printerOnline = Boolean(printerStatus?.connected)
  const printerState = printerStatus?.status || (printerOnline ? 'LINKED' : 'STANDBY')
  const canSelect = Boolean(backendOnline) && !loading
  const selectedApp = externalApps.find(app => app.id === selectedAppId) || null
  const printerTransport = typeof printerStatus?.transport === 'string'
    ? printerStatus.transport
    : typeof printerStatus?.connectionType === 'string'
      ? printerStatus.connectionType
      : printerStatus?.port || 'USB / WI-FI SETUP IN DEVICES'

  const loadExternalApps = useCallback(async () => {
    if (!backendOnline) {
      setExternalApps([])
      setSelectedAppId('')
      setAppsError('Connect the local Core to manage external applications.')
      return []
    }

    setAppsLoading(true)
    setAppsError('')
    try {
      const response = await fetch(`${BACKEND}/api/models/apps`, { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(responseMessage(payload, 'The external software bridge is unavailable.'))
      const nextApps = (Array.isArray(payload?.apps) ? payload.apps : [])
        .map(normalizeExternalApp)
        .filter(Boolean)
      setExternalApps(nextApps)
      setSelectedAppId(current => {
        if (current && nextApps.some(app => app.id === current)) return current
        return nextApps.find(app => app.available && app.launchesFiles)?.id || nextApps[0]?.id || ''
      })
      return nextApps
    } catch (caught) {
      setExternalApps([])
      setSelectedAppId('')
      setAppsError(caught instanceof Error ? caught.message : 'The external software bridge is unavailable.')
      return []
    } finally {
      setAppsLoading(false)
    }
  }, [backendOnline])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadExternalApps()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadExternalApps])

  const selectAsset = useCallback(async () => {
    if (!backendOnline || loading) return
    let selectedAsset = null
    setLoading(true)
    setError('')
    setNotice('OPENING LOCAL ASSET SELECTOR…')

    try {
      const nativePicker = desktopBridge()
      let payload

      if (nativePicker) {
        payload = await nativePicker.selectModel()
      } else {
        let response = await fetch(`${BACKEND}/api/models/pick`, { method: 'POST' })
        if (response.status === 405) response = await fetch(`${BACKEND}/api/models/pick`)
        payload = await response.json().catch(() => null)
        if (!response.ok) throw new Error(responseMessage(payload, 'The local file selector is unavailable.'))
      }

      if (payload?.cancelled || payload?.canceled) {
        setNotice('ASSET SELECTION CANCELLED')
        return
      }

      selectedAsset = normalizeAsset(payload)
      if (!selectedAsset) throw new Error('No model file was returned by the selector.')

      const capability = previewCapability(selectedAsset)
      setModel(null)
      setStats(null)
      setAsset(selectedAsset)
      setPreview(capability)

      if (capability.mode !== 'render') {
        setNotice(`${selectedAsset.format.toUpperCase()} CATALOGUED // READY FOR EXTERNAL SOFTWARE`)
        return
      }

      setNotice(`READING ${selectedAsset.name.toUpperCase()}…`)
      const content = await fetch(`${BACKEND}/api/models/file?path=${encodeURIComponent(selectedAsset.path)}`)
      if (!content.ok) {
        const contentPayload = await content.json().catch(() => null)
        throw new Error(responseMessage(contentPayload, 'Ultron AI non è riuscito a leggere il modello selezionato.'))
      }
      const buffer = await content.arrayBuffer()
      const parsed = await parseModel(selectedAsset.extension, buffer)
      const nextStats = estimateModelStats(parsed)

      setModel(parsed)
      setAsset({ ...selectedAsset, size: selectedAsset.size ?? buffer.byteLength })
      setStats(nextStats)
      setPreview({ mode: 'render', reason: '' })
      setResetToken(token => token + 1)
      setNotice('GEOMETRY VERIFIED // READY FOR FABRICATION')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The model could not be decoded.'
      if (selectedAsset) {
        setModel(null)
        setStats(null)
        setAsset(selectedAsset)
        setPreview({
          mode: 'failed',
          reason: `${message} The file remains catalogued and can be opened in a compatible local application.`,
        })
        setNotice('ASSET CATALOGUED // LOCAL PREVIEW UNAVAILABLE')
      } else {
        setError(message)
        setNotice('ASSET ACQUISITION INTERRUPTED')
      }
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
      if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, 'The local file browser could not reveal the model.'))
      setNotice('LOCAL FILE LOCATION REVEALED')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local file browser could not reveal the model.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, asset])

  const registerExternalApp = useCallback(async event => {
    event.preventDefault()
    if (!backendOnline || actionLoading) return
    setActionLoading('pick-app')
    setAppsError('')
    setError('')
    try {
      const label = softwareLabel.trim().slice(0, 80)
      const nativePicker = desktopBridge()
      let payload

      if (nativePicker) {
        payload = await nativePicker.selectExternalApp(label)
      } else {
        const response = await fetch(`${BACKEND}/api/models/apps/pick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label || undefined }),
        })
        payload = await response.json().catch(() => null)
        if (!response.ok) throw new Error(responseMessage(payload, 'The application could not be added.'))
      }

      if (payload?.ok === false) throw new Error(responseMessage(payload, 'The application could not be added.'))
      if (payload?.cancelled || payload?.canceled) return

      const app = normalizeExternalApp(payload?.app)
      if (app) {
        setExternalApps(current => [...current.filter(item => item.id !== app.id), app])
        setSelectedAppId(app.id)
      }
      setSoftwareLabel('')
      setNotice(`${app?.name || 'EXTERNAL APPLICATION'} LINKED TO THE MODEL DECK`)
      await loadExternalApps()
    } catch (caught) {
      setAppsError(caught instanceof Error ? caught.message : 'The application could not be added.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, backendOnline, loadExternalApps, softwareLabel])

  const launchExternalApp = useCallback(async () => {
    if (!asset || !selectedApp || actionLoading) return
    setActionLoading('external')
    setError('')
    try {
      if (!selectedApp.available || !selectedApp.launchesFiles) {
        throw new Error(`${selectedApp.name} is not currently available for file handoff.`)
      }
      const response = await fetch(`${BACKEND}/api/models/open-external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: asset.path, appId: selectedApp.id }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, `${selectedApp.name} could not receive this file.`))
      setNotice(`${selectedApp.name.toUpperCase()} OPENED WITH ${asset.name.toUpperCase()}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The external application could not be opened.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, asset, selectedApp])

  const launchSelectedSoftware = useCallback(async () => {
    if (!selectedApp || actionLoading) return
    setActionLoading('external-launch')
    setAppsError('')
    try {
      if (!selectedApp.available || !selectedApp.launchesFiles) {
        throw new Error(`${selectedApp.name} is not currently available on this computer.`)
      }
      const response = await fetch(`${BACKEND}/api/models/apps/${encodeURIComponent(selectedApp.id)}/launch`, {
        method: 'POST',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, `${selectedApp.name} could not be opened.`))
      setNotice(`${selectedApp.name.toUpperCase()} OPENED — USE ITS OWN PRINTER CONNECTION SCREEN`)
    } catch (caught) {
      setAppsError(caught instanceof Error ? caught.message : 'The linked application could not be opened.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, selectedApp])

  const removeSelectedSoftware = useCallback(async () => {
    if (!selectedApp?.configured || actionLoading) return
    setActionLoading('remove-app')
    setAppsError('')
    try {
      const response = await fetch(`${BACKEND}/api/models/apps/${encodeURIComponent(selectedApp.id)}`, {
        method: 'DELETE',
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(responseMessage(payload, 'The linked application could not be removed.'))
      setNotice(`${selectedApp.name.toUpperCase()} REMOVED FROM THIS LOCAL ACCOUNT`)
      await loadExternalApps()
    } catch (caught) {
      setAppsError(caught instanceof Error ? caught.message : 'The linked application could not be removed.')
    } finally {
      setActionLoading('')
    }
  }, [actionLoading, loadExternalApps, selectedApp])

  const metrics = useMemo(() => {
    const telemetry = asset?.telemetry || {}
    const toolpath = ['gcode', 'gco', 'gc', 'g', 'nc', 'tap'].includes(asset?.extension)
    const meshCount = stats?.triangles ?? telemetry.triangles ?? telemetry.faces ?? telemetry.facetsInSample
    const pathCount = stats?.toolpathSegments ?? telemetry.pathSegments
    const metadataMode = Boolean(asset && !model)

    return [
      { label: 'FORMAT', value: asset ? asset.format || `.${asset.extension.toUpperCase()}` : '—', detail: asset ? 'LOCAL CATALOGUE' : 'NO ASSET' },
      { label: 'VIEW MODE', value: model && rendererAvailable ? 'LIVE' : asset ? 'METADATA' : '—', detail: model && rendererAvailable ? 'INTERACTIVE INSPECTION' : metadataMode ? 'NATIVE APP HANDOFF' : 'AWAITING INPUT' },
      toolpath
        ? { label: 'PATH SEGMENTS', value: formatTriangles(pathCount), detail: pathCount ? 'FABRICATION ROUTES' : 'READ ON OPEN' }
        : { label: 'MESH DATA', value: formatTriangles(meshCount), detail: meshCount ? 'LOCAL MODEL FACTS' : asset ? 'NATIVE APP ANALYSIS' : 'AWAITING SCAN' },
      { label: 'FILE SIZE', value: formatBytes(asset?.size), detail: asset?.modified ? 'LOCAL STORAGE' : 'NO ASSET' },
    ]
  }, [asset, model, rendererAvailable, stats])

  return (
    <section className="model-deck" aria-label="Ultron AI fabrication model deck">
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
            <div className="model-deck-hero-tools">
              {asset && <span className="model-deck-preview-state" data-mode={preview.mode}>{model && rendererAvailable ? 'LIVE PREVIEW' : 'METADATA VIEW'}</span>}
              <button
                type="button"
                className="model-deck-reset-view"
                onClick={() => setResetToken(token => token + 1)}
                disabled={!model || !rendererAvailable}
              >
                RESET OPTICS
              </button>
            </div>
          </div>
          <ModelDeckPreviewBoundary asset={asset} onRendererUnavailable={markRendererUnavailable}>
            <ModelViewport
              model={model}
              asset={asset}
              loading={loading}
              preview={preview}
              resetToken={resetToken}
              rendererAvailable={rendererAvailable}
              onRendererUnavailable={markRendererUnavailable}
            />
          </ModelDeckPreviewBoundary>
          <div className="model-deck-hero-footer">
            <span>{model && rendererAvailable ? 'ROTATE // INSPECT // ZOOM' : 'CATALOGUE // HANDOFF // INSPECT'}</span>
            <span><AssetPreviewState asset={asset} model={model} preview={preview} rendererAvailable={rendererAvailable} /></span>
          </div>
        </section>

        <aside className="model-deck-analysis">
          <section className="model-deck-status-panel">
            <div className="model-deck-section-title"><span>FABRICATION CELL</span><b>02</b></div>
            <FabricationPrinterVisual online={printerOnline} />
            <div className="model-deck-printer-readout">
              <strong>{printerOnline ? '3D PRINTER LINKED' : 'NO PRINTER LINKED'}</strong>
              <span>{printerState}</span>
              <small>{printerTransport}</small>
            </div>
          </section>

          <section className="model-deck-metrics-panel">
            <div className="model-deck-section-title"><span>GEOMETRY TELEMETRY</span><b>LIVE</b></div>
            <div className="model-deck-metrics">
              {metrics.map(metric => <Metric key={metric.label} {...metric} active={Boolean(asset)} />)}
            </div>
          </section>

          <section className="model-deck-software-panel">
            <div className="model-deck-section-title">
              <span>SOFTWARE BRIDGE</span>
              <button type="button" onClick={loadExternalApps} disabled={appsLoading || !backendOnline} title="Refresh external applications">
                {appsLoading ? 'SYNC…' : 'SYNC'}
              </button>
            </div>
            <p>Collega uno slicer, uno strumento CAD o un software per stampanti locale. Ultron AI apre soltanto l’app e il modello che scegli esplicitamente.</p>
            {externalApps.length > 0 ? (
              <div className="model-deck-software-list" role="list" aria-label="Linked external applications">
                {externalApps.map(app => (
                  <button
                    type="button"
                    className="model-deck-software-app"
                    key={app.id}
                    data-selected={app.id === selectedAppId ? 'true' : 'false'}
                    data-available={app.available && app.launchesFiles ? 'true' : 'false'}
                    onClick={() => setSelectedAppId(app.id)}
                    title={`Use ${app.name} for the selected local file`}
                  >
                    <i />
                    <span><strong>{app.name}</strong><small>{app.kind}{app.supports.length ? ` · ${app.supports.slice(0, 4).join(', ')}` : ''}</small></span>
                    <em>{app.available && app.launchesFiles ? 'READY' : 'CHECK APP'}</em>
                  </button>
                ))}
              </div>
            ) : (
              <div className="model-deck-software-empty">NO APP LINKED YET · ADD ULTIMAKER CURA, BAMBU STUDIO OR YOUR OWN LOCAL TOOL.</div>
            )}
            <form className="model-deck-software-add" onSubmit={registerExternalApp}>
              <label htmlFor="model-deck-software-label">APP LABEL</label>
              <input
                id="model-deck-software-label"
                value={softwareLabel}
                onChange={event => setSoftwareLabel(event.target.value)}
                maxLength="80"
                placeholder="Bambu Studio, Cura, CAD…"
              />
              <button type="submit" disabled={!backendOnline || Boolean(actionLoading)}>
                {actionLoading === 'pick-app' ? 'CHOOSING…' : 'ADD APP'}
              </button>
            </form>
            <div className="model-deck-software-actions">
              <button
                type="button"
                onClick={launchSelectedSoftware}
                disabled={!selectedApp?.available || !selectedApp?.launchesFiles || Boolean(actionLoading)}
                title={selectedApp ? `Open ${selectedApp.name}` : 'Choose a linked application first'}
              >
                {actionLoading === 'external-launch' ? 'OPENING…' : selectedApp ? `OPEN ${selectedApp.name.toUpperCase()}` : 'OPEN SELECTED APP'}
              </button>
              {selectedApp?.configured && (
                <button
                  type="button"
                  className="model-deck-software-remove"
                  onClick={removeSelectedSoftware}
                  disabled={Boolean(actionLoading)}
                  title={`Remove ${selectedApp.name} from this local account`}
                >
                  {actionLoading === 'remove-app' ? 'REMOVING…' : 'REMOVE LINK'}
                </button>
              )}
            </div>
            {appsError && <p className="model-deck-software-feedback">{appsError}</p>}
          </section>

          <FormatCatalogue />

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
          <ActionButton onClick={selectAsset} disabled={!canSelect} tone="primary" title={backendOnline ? 'Select a local STL, OBJ, 3MF, AMF, PLY or G-code file' : 'Connetti prima il Core locale di Ultron AI'}>
            {loading ? 'READING ASSET…' : 'SELECT ASSET'}
          </ActionButton>
          <ActionButton onClick={launchCura} disabled={!asset || Boolean(actionLoading)} tone="danger" title="Open this asset in Ultimaker Cura">
            {actionLoading === 'cura' ? 'OPENING CURA…' : 'OPEN IN CURA'}
          </ActionButton>
          <ActionButton
            onClick={launchExternalApp}
            disabled={!asset || !selectedApp?.available || !selectedApp?.launchesFiles || Boolean(actionLoading)}
            title={selectedApp ? `Open this asset in ${selectedApp.name}` : 'Choose a ready application in Software Bridge first'}
          >
            {actionLoading === 'external' ? 'OPENING APP…' : selectedApp ? `OPEN IN ${selectedApp.name.toUpperCase()}` : 'OPEN IN LINKED APP'}
          </ActionButton>
          <ActionButton onClick={revealAsset} disabled={!asset || Boolean(actionLoading)} title="Reveal this asset in the local file browser">
            {actionLoading === 'reveal' ? 'REVEALING…' : 'REVEAL IN FILE BROWSER'}
          </ActionButton>
        </div>
      </footer>
    </section>
  )
}
