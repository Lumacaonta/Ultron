/* Shared data for the on-demand Neural Core visualizer. */

export const CORE_NODES = [
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

export const SECONDARY_LINKS = [
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

export function isHiddenGraphNode(item = {}) {
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

export function describeCoreNode(node = {}) {
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
    source: base.source || 'Ultron AI Memory',
    description: base.description || `${base.name || 'This node'} is indexed in the Ultron AI neural network.`,
    path: base.path || '',
    linkCount: Number(base.linkCount ?? linkCount),
  }
}
