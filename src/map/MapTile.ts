import { Erosion } from '../utils/erosion'
import { PerlinNoise } from '../utils/perlin-noise'
import * as THREE from 'three'

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

export type NeighborDirection =
  (typeof NeighborDirection)[keyof typeof NeighborDirection]

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

// Erosion configuration
export interface ErosionConfig {
  enabled: boolean // Whether erosion is enabled
  iterations: number // Number of erosion iterations per tile
  inertia: number // Droplet inertia (0-1)
  capacity: number // Sediment capacity multiplier
  deposition: number // Deposition rate
  erosion: number // Erosion rate
  evaporation: number // Evaporation rate
  radius: number // Erosion radius
  minSlope: number // Minimum slope for erosion
  gravity: number // Gravity for droplet speed
}

// Tile configuration
export interface TileConfig {
  size: number // World size of tile
  segments: number // Number of segments per side (visible)
  noiseScale: number // Scale for noise generation
  heightScale: number // Height multiplier
  seed: number // Seed for noise
  erosion: ErosionConfig // Erosion settings
  overlapSegments: number // Number of overlap segments on each side
  showOverlap: boolean // Whether to render overlap area (for debugging)
}

// Default erosion configuration
export const DEFAULT_EROSION_CONFIG: ErosionConfig = {
  enabled: true,
  iterations: 5000,
  inertia: 0.05,
  capacity: 4,
  deposition: 0.1,
  erosion: 0.1,
  evaporation: 0.02,
  radius: 3,
  minSlope: 0.01,
  gravity: 4,
}

// Default configuration
export const DEFAULT_TILE_CONFIG: TileConfig = {
  size: 32,
  segments: 64,
  noiseScale: 8,
  heightScale: 4,
  seed: 12345,
  erosion: DEFAULT_EROSION_CONFIG,
  overlapSegments: 4,
  showOverlap: false,
}

// Cache for heightmaps to avoid regeneration (includes overlap)
const heightMapCache = new Map<string, Float32Array>()

// Cache for eroded heightmaps (separate from raw heightmaps)
const erodedHeightMapCache = new Map<string, Float32Array>()

// Shared geometry cache (key includes showOverlap state)
const geometryCache = new Map<string, THREE.BufferGeometry>()

// Shared erosion instance
let sharedErosion: Erosion | null = null

function getSharedErosion(): Erosion {
  if (!sharedErosion) {
    sharedErosion = new Erosion()
  }
  return sharedErosion
}

// Shared materials
let sharedMaterial: THREE.MeshStandardMaterial | null = null
let sharedOverlapMaterial: THREE.MeshStandardMaterial | null = null

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

function getSharedOverlapMaterial(): THREE.MeshStandardMaterial {
  if (!sharedOverlapMaterial) {
    sharedOverlapMaterial = new THREE.MeshStandardMaterial({
      color: 0x7c4a4e, // Reddish color for overlap visualization
      side: THREE.DoubleSide,
      wireframe: true,
      flatShading: false,
      transparent: true,
      opacity: 0.5,
    })
  }
  return sharedOverlapMaterial
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
  private overlapMesh: THREE.Mesh | null = null
  private geometry: THREE.BufferGeometry | null = null
  private overlapGeometry: THREE.BufferGeometry | null = null

  // Heightmap data (cached, includes overlap)
  private heightMap: Float32Array | null = null

  // Neighbors (8 directions)
  private neighbors: (MapTile | null)[] = new Array(8).fill(null)

  // State
  private isLoaded = false
  private isGenerating = false

  // Perlin noise generator (shared across tiles with same seed)
  private static noiseGenerators = new Map<number, PerlinNoise>()

  constructor(
    tileX: number,
    tileZ: number,
    config: TileConfig = DEFAULT_TILE_CONFIG
  ) {
    this.tileX = tileX
    this.tileZ = tileZ
    this.config = config
  }

  // Get unique key for this tile
  public get key(): string {
    return `${this.tileX}_${this.tileZ}`
  }

  // Get world position (visible tile start)
  public get worldX(): number {
    return this.tileX * this.config.size
  }

  public get worldZ(): number {
    return this.tileZ * this.config.size
  }

  // Get world position including overlap (virtual tile start)
  public get virtualWorldX(): number {
    return this.worldX - this.overlapWorldSize
  }

  public get virtualWorldZ(): number {
    return this.worldZ - this.overlapWorldSize
  }

  // Get overlap size in world units
  private get overlapWorldSize(): number {
    const segmentSize = this.config.size / this.config.segments
    return this.config.overlapSegments * segmentSize
  }

  // Get total virtual size including both overlaps
  public get virtualSize(): number {
    return this.config.size + 2 * this.overlapWorldSize
  }

  // Get total virtual segments (including overlap on both sides)
  private get virtualSegments(): number {
    return this.config.segments + 2 * this.config.overlapSegments
  }

  // Get total virtual vertex count per side
  private get virtualVertexCount(): number {
    return this.virtualSegments + 1
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

  // Generate raw heightmap without erosion (cached, includes overlap)
  private generateRawHeightMap(): Float32Array {
    // Check cache first
    const cached = heightMapCache.get(this.key)
    if (cached) {
      return cached
    }

    const noise = this.getNoiseGenerator()
    const virtualVertexCount = this.virtualVertexCount
    const heightMap = new Float32Array(virtualVertexCount * virtualVertexCount)

    const { noiseScale, heightScale } = this.config
    const segmentSize = this.config.size / this.config.segments

    // Generate heightmap for virtual area (including overlap)
    for (let i = 0; i < virtualVertexCount; i++) {
      // World Z coordinate (starts before visible tile due to overlap)
      const z = this.virtualWorldZ + i * segmentSize

      for (let j = 0; j < virtualVertexCount; j++) {
        // World X coordinate (starts before visible tile due to overlap)
        const x = this.virtualWorldX + j * segmentSize

        // Use world coordinates for seamless noise
        const height =
          noise.noise2D(x / noiseScale, z / noiseScale) * heightScale

        heightMap[i * virtualVertexCount + j] = height
      }
    }

    // Cache the raw heightmap
    heightMapCache.set(this.key, heightMap)

    return heightMap
  }

  // Apply erosion to heightmap
  private applyErosion(heightMap: Float32Array): Float32Array {
    const { erosion: erosionConfig } = this.config

    if (!erosionConfig.enabled) {
      return heightMap
    }

    // Check eroded cache
    const cachedEroded = erodedHeightMapCache.get(this.key)
    if (cachedEroded) {
      return cachedEroded
    }

    // Copy heightmap for erosion (don't modify original)
    const erodedMap = new Float32Array(heightMap)

    const virtualVertexCount = this.virtualVertexCount

    // Configure erosion with tile settings
    const erosion = getSharedErosion()
    erosion.inertia = erosionConfig.inertia
    erosion.capacity = erosionConfig.capacity
    erosion.deposition = erosionConfig.deposition
    erosion.erosion = erosionConfig.erosion
    erosion.evaporation = erosionConfig.evaporation
    erosion.radius = erosionConfig.radius
    erosion.minSlope = erosionConfig.minSlope
    erosion.gravity = erosionConfig.gravity

    // Apply erosion on full virtual heightmap (including overlap)
    erosion.erode(
      erodedMap,
      virtualVertexCount,
      virtualVertexCount,
      erosionConfig.iterations
    )

    // Cache the eroded heightmap
    erodedHeightMapCache.set(this.key, erodedMap)

    return erodedMap
  }

  // Generate heightmap with optional erosion (cached)
  private generateHeightMap(): Float32Array {
    // Generate or get raw heightmap
    const rawHeightMap = this.generateRawHeightMap()

    // Apply erosion if enabled
    return this.applyErosion(rawHeightMap)
  }

  // Generate geometry for visible area only
  private generateVisibleGeometry(): THREE.BufferGeometry {
    const cacheKey = `${this.key}_visible`
    const cachedGeometry = geometryCache.get(cacheKey)
    if (cachedGeometry) {
      return cachedGeometry
    }

    const heightMap = this.heightMap || this.generateHeightMap()
    const { size, segments, overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount
    const visibleVertexCount = segments + 1

    // Create vertices for visible area
    const vertices = new Float32Array(
      visibleVertexCount * visibleVertexCount * 3
    )
    let vertexIndex = 0

    const segmentSize = size / segments

    for (let i = 0; i < visibleVertexCount; i++) {
      const z = i * segmentSize

      for (let j = 0; j < visibleVertexCount; j++) {
        const x = j * segmentSize

        // Get height from virtual heightmap (offset by overlap)
        const virtualI = i + overlapSegments
        const virtualJ = j + overlapSegments
        const y = heightMap[virtualI * virtualVertexCount + virtualJ]

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
        const a = i * visibleVertexCount + j
        const b = i * visibleVertexCount + j + 1
        const c = (i + 1) * visibleVertexCount + j
        const d = (i + 1) * visibleVertexCount + j + 1

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
    geometryCache.set(cacheKey, geometry)

    return geometry
  }

  // Generate geometry for overlap areas (for visualization)
  private generateOverlapGeometry(): THREE.BufferGeometry | null {
    const { overlapSegments } = this.config
    if (overlapSegments === 0) return null

    const cacheKey = `${this.key}_overlapGeo`
    const cachedGeometry = geometryCache.get(cacheKey)
    if (cachedGeometry) {
      return cachedGeometry
    }

    const heightMap = this.heightMap || this.generateHeightMap()
    const virtualVertexCount = this.virtualVertexCount
    const virtualSegments = this.virtualSegments
    const segmentSize = this.config.size / this.config.segments

    // Create vertices for entire virtual area
    const vertices = new Float32Array(
      virtualVertexCount * virtualVertexCount * 3
    )
    let vertexIndex = 0

    for (let i = 0; i < virtualVertexCount; i++) {
      // Position relative to visible tile start
      const z = (i - overlapSegments) * segmentSize

      for (let j = 0; j < virtualVertexCount; j++) {
        const x = (j - overlapSegments) * segmentSize
        const y = heightMap[i * virtualVertexCount + j]

        vertices[vertexIndex++] = x
        vertices[vertexIndex++] = y
        vertices[vertexIndex++] = z
      }
    }

    // Create indices only for overlap areas (not the center)
    const indicesList: number[] = []

    for (let i = 0; i < virtualSegments; i++) {
      for (let j = 0; j < virtualSegments; j++) {
        // Check if this quad is in the overlap area (not in center)
        const inOverlapX =
          j < overlapSegments || j >= this.config.segments + overlapSegments
        const inOverlapZ =
          i < overlapSegments || i >= this.config.segments + overlapSegments

        if (inOverlapX || inOverlapZ) {
          const a = i * virtualVertexCount + j
          const b = i * virtualVertexCount + j + 1
          const c = (i + 1) * virtualVertexCount + j
          const d = (i + 1) * virtualVertexCount + j + 1

          indicesList.push(a, b, d)
          indicesList.push(a, d, c)
        }
      }
    }

    if (indicesList.length === 0) return null

    const indices = new Uint32Array(indicesList)

    // Create geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeVertexNormals()

    // Cache geometry
    geometryCache.set(cacheKey, geometry)

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

    // Generate visible geometry
    this.geometry = this.generateVisibleGeometry()

    if (this.mesh) {
      // Reuse pooled mesh
      this.mesh.geometry = this.geometry
      this.mesh.material = getSharedMaterial()
      this.mesh.position.set(this.worldX, 0, this.worldZ)
      this.mesh.visible = true
    } else {
      // Create new mesh
      this.mesh = new THREE.Mesh(this.geometry, getSharedMaterial())
      this.mesh.position.set(this.worldX, 0, this.worldZ)
    }

    // Add to scene if not already there
    if (!this.mesh.parent) {
      scene.add(this.mesh)
    }

    // Handle overlap visualization
    if (this.config.showOverlap && this.config.overlapSegments > 0) {
      this.overlapGeometry = this.generateOverlapGeometry()
      if (this.overlapGeometry) {
        this.overlapMesh = new THREE.Mesh(
          this.overlapGeometry,
          getSharedOverlapMaterial()
        )
        this.overlapMesh.position.set(this.worldX, 0.01, this.worldZ) // Slight offset to avoid z-fighting
        scene.add(this.overlapMesh)
      }
    }

    this.isLoaded = true
    this.isGenerating = false
  }

  // Unload tile (remove from scene, return mesh to pool)
  public unload(): void {
    if (!this.isLoaded) return

    if (this.mesh) {
      // Return mesh to pool instead of disposing
      returnMeshToPool(this.mesh)
      this.mesh = null
    }

    if (this.overlapMesh) {
      if (this.overlapMesh.parent) {
        this.overlapMesh.parent.remove(this.overlapMesh)
      }
      this.overlapMesh.geometry.dispose()
      this.overlapMesh = null
    }

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

    if (this.overlapMesh) {
      if (this.overlapMesh.parent) {
        this.overlapMesh.parent.remove(this.overlapMesh)
      }
      this.overlapMesh.geometry.dispose()
      this.overlapMesh = null
    }

    // Clear from caches
    heightMapCache.delete(this.key)
    erodedHeightMapCache.delete(this.key)
    geometryCache.delete(`${this.key}_visible`)
    geometryCache.delete(`${this.key}_overlapGeo`)

    this.heightMap = null
    this.geometry = null
    this.overlapGeometry = null
    this.isLoaded = false

    // Clear neighbor references
    this.neighbors.fill(null)
  }

  // Get height at world position (with interpolation)
  public getHeightAt(worldX: number, worldZ: number): number | null {
    if (!this.heightMap) return null

    // Convert to virtual local coordinates
    const localX = worldX - this.virtualWorldX
    const localZ = worldZ - this.virtualWorldZ

    const segmentSize = this.config.size / this.config.segments
    const virtualSize = this.virtualSize

    // Check bounds (within virtual area)
    if (
      localX < 0 ||
      localX > virtualSize ||
      localZ < 0 ||
      localZ > virtualSize
    ) {
      return null
    }

    const virtualVertexCount = this.virtualVertexCount

    // Convert to grid coordinates
    const gridX = localX / segmentSize
    const gridZ = localZ / segmentSize

    const x0 = Math.floor(gridX)
    const z0 = Math.floor(gridZ)
    const x1 = Math.min(x0 + 1, this.virtualSegments)
    const z1 = Math.min(z0 + 1, this.virtualSegments)

    const fx = gridX - x0
    const fz = gridZ - z0

    // Bilinear interpolation
    const h00 = this.heightMap[z0 * virtualVertexCount + x0]
    const h10 = this.heightMap[z0 * virtualVertexCount + x1]
    const h01 = this.heightMap[z1 * virtualVertexCount + x0]
    const h11 = this.heightMap[z1 * virtualVertexCount + x1]

    const h0 = h00 * (1 - fx) + h10 * fx
    const h1 = h01 * (1 - fx) + h11 * fx

    return h0 * (1 - fz) + h1 * fz
  }

  // Get raw heightmap data (for neighbor tiles to use)
  public getHeightMapData(): Float32Array | null {
    return this.heightMap
  }

  // Get height at virtual grid position (for neighbor access)
  public getHeightAtGrid(gridX: number, gridZ: number): number | null {
    if (!this.heightMap) return null

    const virtualVertexCount = this.virtualVertexCount
    if (
      gridX < 0 ||
      gridX >= virtualVertexCount ||
      gridZ < 0 ||
      gridZ >= virtualVertexCount
    ) {
      return null
    }

    return this.heightMap[gridZ * virtualVertexCount + gridX]
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
    erodedHeightMapCache.clear()
    geometryCache.clear()
    MapTile.noiseGenerators.clear()

    // Dispose pooled meshes
    for (const mesh of meshPool) {
      mesh.geometry.dispose()
    }
    meshPool.length = 0

    // Dispose shared materials
    if (sharedMaterial) {
      sharedMaterial.dispose()
      sharedMaterial = null
    }
    if (sharedOverlapMaterial) {
      sharedOverlapMaterial.dispose()
      sharedOverlapMaterial = null
    }

    // Clear shared erosion
    sharedErosion = null
  }

  // Get cache stats (for debugging)
  public static getCacheStats(): {
    heightMaps: number
    erodedHeightMaps: number
    geometries: number
    pooledMeshes: number
  } {
    return {
      heightMaps: heightMapCache.size,
      erodedHeightMaps: erodedHeightMapCache.size,
      geometries: geometryCache.size,
      pooledMeshes: meshPool.length,
    }
  }

  // Update showOverlap setting and reload if needed
  public setShowOverlap(show: boolean, scene: THREE.Scene): void {
    if (this.config.showOverlap === show) return

    this.config.showOverlap = show

    if (this.isLoaded) {
      // Remove old overlap mesh if exists
      if (this.overlapMesh) {
        if (this.overlapMesh.parent) {
          this.overlapMesh.parent.remove(this.overlapMesh)
        }
        this.overlapMesh.geometry.dispose()
        this.overlapMesh = null
      }

      // Add new overlap mesh if needed
      if (show && this.config.overlapSegments > 0) {
        this.overlapGeometry = this.generateOverlapGeometry()
        if (this.overlapGeometry) {
          this.overlapMesh = new THREE.Mesh(
            this.overlapGeometry,
            getSharedOverlapMaterial()
          )
          this.overlapMesh.position.set(this.worldX, 0.01, this.worldZ)
          scene.add(this.overlapMesh)
        }
      }
    }
  }
}
