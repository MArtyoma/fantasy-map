import * as THREE from 'three'
import { PerlinNoise } from '../utils/perlin-noise'

// Neighbor directions
export const NeighborDirection = {
  North: 0,
  NorthEast: 1,
  East: 2,
  SouthEast: 3,
  South: 4,
  SouthWest: 5,
  West: 6,
  NorthWest: 7,
} as const

export type NeighborDirection = (typeof NeighborDirection)[keyof typeof NeighborDirection]

// Direction offsets for neighbor calculation
const NEIGHBOR_OFFSETS: [number, number][] = [
  [0, -1], // North
  [1, -1], // NorthEast
  [1, 0], // East
  [1, 1], // SouthEast
  [0, 1], // South
  [-1, 1], // SouthWest
  [-1, 0], // West
  [-1, -1], // NorthWest
]

// Tile configuration
export interface TileConfig {
  size: number // World size of tile
  segments: number // Number of segments per side
  noiseScale: number // Scale for noise generation
  heightScale: number // Height multiplier
  seed: number // Seed for noise
}

// Default configuration
export const DEFAULT_TILE_CONFIG: TileConfig = {
  size: 32,
  segments: 64,
  noiseScale: 8,
  heightScale: 4,
  seed: 12345,
}

// Cache for heightmaps to avoid regeneration
const heightMapCache = new Map<string, Float32Array>()

// Shared geometry cache
const geometryCache = new Map<string, THREE.BufferGeometry>()

// Shared material (reused across all tiles)
let sharedMaterial: THREE.MeshStandardMaterial | null = null

function getSharedMaterial(): THREE.MeshStandardMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a7c4e,
      side: THREE.DoubleSide,
      wireframe: false,
      flatShading: false,
    })
  }
  return sharedMaterial
}

// Object pool for meshes
const meshPool: THREE.Mesh[] = []

function getMeshFromPool(): THREE.Mesh | null {
  return meshPool.pop() || null
}

function returnMeshToPool(mesh: THREE.Mesh): void {
  mesh.visible = false
  meshPool.push(mesh)
}

export class MapTile {
  // Tile coordinates (grid position, not world position)
  public readonly tileX: number
  public readonly tileZ: number

  // Configuration
  private config: TileConfig

  // Three.js objects
  private mesh: THREE.Mesh | null = null
  private geometry: THREE.BufferGeometry | null = null

  // Heightmap data (cached)
  private heightMap: Float32Array | null = null

  // Neighbors (8 directions)
  private neighbors: (MapTile | null)[] = new Array(8).fill(null)

  // State
  private isLoaded = false
  private isGenerating = false

  // Perlin noise generator (shared across tiles with same seed)
  private static noiseGenerators = new Map<number, PerlinNoise>()

  constructor(tileX: number, tileZ: number, config: TileConfig = DEFAULT_TILE_CONFIG) {
    this.tileX = tileX
    this.tileZ = tileZ
    this.config = config
  }

  // Get unique key for this tile
  public get key(): string {
    return `${this.tileX}_${this.tileZ}`
  }

  // Get world position
  public get worldX(): number {
    return this.tileX * this.config.size
  }

  public get worldZ(): number {
    return this.tileZ * this.config.size
  }

  // Get center position in world coordinates
  public get centerX(): number {
    return this.worldX + this.config.size / 2
  }

  public get centerZ(): number {
    return this.worldZ + this.config.size / 2
  }

  // Get noise generator (cached per seed)
  private getNoiseGenerator(): PerlinNoise {
    let noise = MapTile.noiseGenerators.get(this.config.seed)
    if (!noise) {
      noise = new PerlinNoise(this.config.seed)
      MapTile.noiseGenerators.set(this.config.seed, noise)
    }
    return noise
  }

  // Set neighbor
  public setNeighbor(direction: NeighborDirection, tile: MapTile | null): void {
    this.neighbors[direction] = tile
  }

  // Get neighbor
  public getNeighbor(direction: NeighborDirection): MapTile | null {
    return this.neighbors[direction]
  }

  // Get all neighbors
  public getNeighbors(): (MapTile | null)[] {
    return [...this.neighbors]
  }

  // Check if tile is loaded
  public get loaded(): boolean {
    return this.isLoaded
  }

  // Generate heightmap (cached)
  private generateHeightMap(): Float32Array {
    // Check cache first
    const cached = heightMapCache.get(this.key)
    if (cached) {
      return cached
    }

    const noise = this.getNoiseGenerator()
    const vertexCount = this.config.segments + 1
    const heightMap = new Float32Array(vertexCount * vertexCount)

    const { size, segments, noiseScale, heightScale } = this.config

    for (let i = 0; i < vertexCount; i++) {
      const z = (i / segments) * size + this.worldZ

      for (let j = 0; j < vertexCount; j++) {
        const x = (j / segments) * size + this.worldX

        // Use world coordinates for seamless noise
        const height = noise.noise2D(x / noiseScale, z / noiseScale) * heightScale

        heightMap[i * vertexCount + j] = height
      }
    }

    // Cache the heightmap
    heightMapCache.set(this.key, heightMap)

    return heightMap
  }

  // Generate geometry
  private generateGeometry(): THREE.BufferGeometry {
    // Check geometry cache
    const cachedGeometry = geometryCache.get(this.key)
    if (cachedGeometry) {
      return cachedGeometry
    }

    const heightMap = this.heightMap || this.generateHeightMap()
    const { size, segments } = this.config
    const vertexCount = segments + 1

    // Create vertices
    const vertices = new Float32Array(vertexCount * vertexCount * 3)
    let vertexIndex = 0

    for (let i = 0; i < vertexCount; i++) {
      const z = (i / segments) * size

      for (let j = 0; j < vertexCount; j++) {
        const x = (j / segments) * size
        const y = heightMap[i * vertexCount + j]

        vertices[vertexIndex++] = x
        vertices[vertexIndex++] = y
        vertices[vertexIndex++] = z
      }
    }

    // Create indices
    const indices = new Uint32Array(segments * segments * 6)
    let indexOffset = 0

    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * vertexCount + j
        const b = i * vertexCount + j + 1
        const c = (i + 1) * vertexCount + j
        const d = (i + 1) * vertexCount + j + 1

        indices[indexOffset++] = a
        indices[indexOffset++] = b
        indices[indexOffset++] = d

        indices[indexOffset++] = a
        indices[indexOffset++] = d
        indices[indexOffset++] = c
      }
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeVertexNormals()

    // Cache geometry
    geometryCache.set(this.key, geometry)

    return geometry
  }

  // Load tile (create mesh and add to scene)
  public load(scene: THREE.Scene): void {
    if (this.isLoaded || this.isGenerating) return

    this.isGenerating = true

    // Generate heightmap if not cached
    this.heightMap = this.generateHeightMap()

    // Try to get mesh from pool
    this.mesh = getMeshFromPool()

    if (this.mesh) {
      // Reuse pooled mesh
      this.geometry = this.generateGeometry()
      this.mesh.geometry = this.geometry
      this.mesh.position.set(this.worldX, 0, this.worldZ)
      this.mesh.visible = true
    } else {
      // Create new mesh
      this.geometry = this.generateGeometry()
      this.mesh = new THREE.Mesh(this.geometry, getSharedMaterial())
      this.mesh.position.set(this.worldX, 0, this.worldZ)
      scene.add(this.mesh)
    }

    // Add to scene if not already there
    if (!this.mesh.parent) {
      scene.add(this.mesh)
    }

    this.isLoaded = true
    this.isGenerating = false
  }

  // Unload tile (remove from scene, return mesh to pool)
  public unload(): void {
    if (!this.isLoaded || !this.mesh) return

    // Return mesh to pool instead of disposing
    returnMeshToPool(this.mesh)

    // Clear references but keep cached data
    this.mesh = null
    this.isLoaded = false
  }

  // Fully dispose (clear all cached data)
  public dispose(): void {
    if (this.mesh) {
      if (this.mesh.parent) {
        this.mesh.parent.remove(this.mesh)
      }
      this.mesh.geometry.dispose()
      this.mesh = null
    }

    // Clear from caches
    heightMapCache.delete(this.key)
    geometryCache.delete(this.key)

    this.heightMap = null
    this.geometry = null
    this.isLoaded = false

    // Clear neighbor references
    this.neighbors.fill(null)
  }

  // Get height at world position (with interpolation)
  public getHeightAt(worldX: number, worldZ: number): number | null {
    if (!this.heightMap) return null

    const localX = worldX - this.worldX
    const localZ = worldZ - this.worldZ
    const { size, segments } = this.config

    // Check bounds
    if (localX < 0 || localX > size || localZ < 0 || localZ > size) {
      return null
    }

    const vertexCount = segments + 1

    // Convert to grid coordinates
    const gridX = (localX / size) * segments
    const gridZ = (localZ / size) * segments

    const x0 = Math.floor(gridX)
    const z0 = Math.floor(gridZ)
    const x1 = Math.min(x0 + 1, segments)
    const z1 = Math.min(z0 + 1, segments)

    const fx = gridX - x0
    const fz = gridZ - z0

    // Bilinear interpolation
    const h00 = this.heightMap[z0 * vertexCount + x0]
    const h10 = this.heightMap[z0 * vertexCount + x1]
    const h01 = this.heightMap[z1 * vertexCount + x0]
    const h11 = this.heightMap[z1 * vertexCount + x1]

    const h0 = h00 * (1 - fx) + h10 * fx
    const h1 = h01 * (1 - fx) + h11 * fx

    return h0 * (1 - fz) + h1 * fz
  }

  // Calculate distance to camera (squared for performance)
  public distanceToSquared(x: number, z: number): number {
    const dx = this.centerX - x
    const dz = this.centerZ - z
    return dx * dx + dz * dz
  }

  // Static helper to get neighbor tile coordinates
  public static getNeighborCoords(
    tileX: number,
    tileZ: number,
    direction: NeighborDirection
  ): [number, number] {
    const offset = NEIGHBOR_OFFSETS[direction]
    return [tileX + offset[0], tileZ + offset[1]]
  }

  // Clear all static caches
  public static clearCaches(): void {
    heightMapCache.clear()
    geometryCache.clear()
    MapTile.noiseGenerators.clear()

    // Dispose pooled meshes
    for (const mesh of meshPool) {
      mesh.geometry.dispose()
    }
    meshPool.length = 0

    // Dispose shared material
    if (sharedMaterial) {
      sharedMaterial.dispose()
      sharedMaterial = null
    }
  }

  // Get cache stats (for debugging)
  public static getCacheStats(): {
    heightMaps: number
    geometries: number
    pooledMeshes: number
  } {
    return {
      heightMaps: heightMapCache.size,
      geometries: geometryCache.size,
      pooledMeshes: meshPool.length,
    }
  }
}
