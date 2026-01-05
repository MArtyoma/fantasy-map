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

// Cache for blended heightmaps (after neighbor blending)
const blendedHeightMapCache = new Map<string, Float32Array>()

// Shared geometry cache (key includes showOverlap state)
const geometryCache = new Map<string, THREE.BufferGeometry>()

// Smoothstep function for smooth blending
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

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
      wireframe: true,
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
  private needsBlending = true
  private blendVersion = 0 // Incremented when neighbors change
  private lastBlendVersion = -1 // Last version we blended at

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
    const oldNeighbor = this.neighbors[direction]
    if (oldNeighbor !== tile) {
      this.neighbors[direction] = tile
      // Mark that we need to re-blend when neighbor changes
      this.blendVersion++
      this.needsBlending = true
    }
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
          noise.fractalNoise2D(x / noiseScale, z / noiseScale) * heightScale

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

  // Check if this tile needs blending
  public get requiresBlending(): boolean {
    return (
      this.needsBlending &&
      this.isLoaded &&
      this.blendVersion !== this.lastBlendVersion
    )
  }

  // Get the original (unblended) heightmap for consistent blending
  private getOriginalHeightMap(): Float32Array | null {
    // Try eroded cache first, then raw cache
    return (
      erodedHeightMapCache.get(this.key) || heightMapCache.get(this.key) || null
    )
  }

  // Get height from neighbor's ORIGINAL heightmap at exact grid position
  // Returns null if neighbor doesn't have this point
  private getNeighborOriginalHeight(
    neighbor: MapTile,
    visibleI: number,
    visibleJ: number
  ): number | null {
    const neighborOriginal = neighbor.getOriginalHeightMap()
    if (!neighborOriginal) return null

    const { segments, overlapSegments } = this.config

    // Calculate where this vertex is in neighbor's grid
    // Our visible (i,j) -> world position -> neighbor's virtual (ni, nj)

    // Direction from us to neighbor
    const dx = neighbor.tileX - this.tileX
    const dz = neighbor.tileZ - this.tileZ

    // Calculate corresponding position in neighbor's virtual grid
    // If neighbor is to the East (dx=1), our j=segments corresponds to their j=0
    // Our visible vertex (i,j) in neighbor's virtual coordinates:
    let neighborVirtualJ = visibleJ - dx * segments + overlapSegments
    let neighborVirtualI = visibleI - dz * segments + overlapSegments

    const vvc = neighbor.virtualVertexCount

    // Check bounds
    if (
      neighborVirtualI < 0 ||
      neighborVirtualI >= vvc ||
      neighborVirtualJ < 0 ||
      neighborVirtualJ >= vvc
    ) {
      return null
    }

    return neighborOriginal[neighborVirtualI * vvc + neighborVirtualJ]
  }

  // Blend heightmap with neighbors at borders - EXACT vertex matching
  public blendWithNeighbors(): boolean {
    if (!this.heightMap || !this.isLoaded) return false
    if (this.blendVersion === this.lastBlendVersion) return false

    const { segments, overlapSegments } = this.config
    if (overlapSegments === 0) {
      this.needsBlending = false
      this.lastBlendVersion = this.blendVersion
      return false
    }

    // Get our original (unblended) heightmap for consistent results
    const myOriginal = this.getOriginalHeightMap()
    if (!myOriginal) return false

    // Check if we have any loaded neighbors to blend with
    let hasLoadedNeighbor = false
    for (const neighbor of this.neighbors) {
      if (neighbor && neighbor.getOriginalHeightMap()) {
        hasLoadedNeighbor = true
        break
      }
    }

    if (!hasLoadedNeighbor) {
      return false
    }

    // Create blended heightmap from original
    const virtualVertexCount = this.virtualVertexCount
    const blendedMap = new Float32Array(myOriginal)

    const blendDistance = overlapSegments

    // Process each vertex in the visible area
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        // Calculate distance to each edge (in segments)
        const distToNorth = i
        const distToSouth = segments - i
        const distToWest = j
        const distToEast = segments - j

        // Determine which edges this vertex is near
        const nearNorth = distToNorth < blendDistance
        const nearSouth = distToSouth < blendDistance
        const nearWest = distToWest < blendDistance
        const nearEast = distToEast < blendDistance

        if (!nearNorth && !nearSouth && !nearWest && !nearEast) continue

        // Virtual heightmap index
        const virtualI = i + overlapSegments
        const virtualJ = j + overlapSegments
        const idx = virtualI * virtualVertexCount + virtualJ

        // Get my original height
        const myHeight = myOriginal[idx]

        // Collect heights from all relevant neighbors
        const heights: number[] = [myHeight]
        const weights: number[] = [1.0]

        // Check each neighbor direction
        // North neighbor (dz = -1)
        if (nearNorth) {
          const neighbor = this.neighbors[NeighborDirection.North]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight = 1 - distToNorth / blendDistance
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        // South neighbor (dz = +1)
        if (nearSouth) {
          const neighbor = this.neighbors[NeighborDirection.South]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight = 1 - distToSouth / blendDistance
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        // West neighbor (dx = -1)
        if (nearWest) {
          const neighbor = this.neighbors[NeighborDirection.West]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight = 1 - distToWest / blendDistance
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        // East neighbor (dx = +1)
        if (nearEast) {
          const neighbor = this.neighbors[NeighborDirection.East]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight = 1 - distToEast / blendDistance
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        // Corner neighbors for corner vertices
        if (nearNorth && nearWest) {
          const neighbor = this.neighbors[NeighborDirection.NorthWest]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight =
                (1 - distToNorth / blendDistance) *
                (1 - distToWest / blendDistance)
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        if (nearNorth && nearEast) {
          const neighbor = this.neighbors[NeighborDirection.NorthEast]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight =
                (1 - distToNorth / blendDistance) *
                (1 - distToEast / blendDistance)
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        if (nearSouth && nearWest) {
          const neighbor = this.neighbors[NeighborDirection.SouthWest]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight =
                (1 - distToSouth / blendDistance) *
                (1 - distToWest / blendDistance)
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        if (nearSouth && nearEast) {
          const neighbor = this.neighbors[NeighborDirection.SouthEast]
          if (neighbor) {
            const h = this.getNeighborOriginalHeight(neighbor, i, j)
            if (h !== null) {
              const weight =
                (1 - distToSouth / blendDistance) *
                (1 - distToEast / blendDistance)
              heights.push(h)
              weights.push(weight)
            }
          }
        }

        // Calculate weighted average
        if (heights.length > 1) {
          let totalWeight = 0
          let weightedSum = 0

          for (let k = 0; k < heights.length; k++) {
            // Apply smoothstep to weights for smoother blending
            const smoothWeight = smoothstep(0, 1, weights[k])
            weightedSum += heights[k] * smoothWeight
            totalWeight += smoothWeight
          }

          blendedMap[idx] = weightedSum / totalWeight
        }
      }
    }

    // CRITICAL: Ensure exact vertex matching on borders
    // For vertices exactly on the border, use deterministic averaging
    this.ensureExactBorderMatch(blendedMap, myOriginal)

    // Cache the blended heightmap
    blendedHeightMapCache.set(this.key, blendedMap)
    this.heightMap = blendedMap

    this.needsBlending = false
    this.lastBlendVersion = this.blendVersion

    return true
  }

  // Ensure vertices exactly on tile borders match with neighbors
  private ensureExactBorderMatch(
    blendedMap: Float32Array,
    myOriginal: Float32Array
  ): void {
    const { segments, overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount

    // Process each border
    // North border (i = 0)
    const northNeighbor = this.neighbors[NeighborDirection.North]
    if (northNeighbor) {
      const neighborOriginal = northNeighbor.getOriginalHeightMap()
      if (neighborOriginal) {
        for (let j = 0; j <= segments; j++) {
          const myIdx =
            (0 + overlapSegments) * virtualVertexCount + (j + overlapSegments)
          const neighborVirtualI = segments + overlapSegments
          const neighborVirtualJ = j + overlapSegments
          const neighborIdx =
            neighborVirtualI * virtualVertexCount + neighborVirtualJ

          // Average the two heights for exact match
          const avgHeight =
            (myOriginal[myIdx] + neighborOriginal[neighborIdx]) / 2
          blendedMap[myIdx] = avgHeight
        }
      }
    }

    // South border (i = segments)
    const southNeighbor = this.neighbors[NeighborDirection.South]
    if (southNeighbor) {
      const neighborOriginal = southNeighbor.getOriginalHeightMap()
      if (neighborOriginal) {
        for (let j = 0; j <= segments; j++) {
          const myIdx =
            (segments + overlapSegments) * virtualVertexCount +
            (j + overlapSegments)
          const neighborVirtualI = 0 + overlapSegments
          const neighborVirtualJ = j + overlapSegments
          const neighborIdx =
            neighborVirtualI * virtualVertexCount + neighborVirtualJ

          const avgHeight =
            (myOriginal[myIdx] + neighborOriginal[neighborIdx]) / 2
          blendedMap[myIdx] = avgHeight
        }
      }
    }

    // West border (j = 0)
    const westNeighbor = this.neighbors[NeighborDirection.West]
    if (westNeighbor) {
      const neighborOriginal = westNeighbor.getOriginalHeightMap()
      if (neighborOriginal) {
        for (let i = 0; i <= segments; i++) {
          const myIdx =
            (i + overlapSegments) * virtualVertexCount + (0 + overlapSegments)
          const neighborVirtualI = i + overlapSegments
          const neighborVirtualJ = segments + overlapSegments
          const neighborIdx =
            neighborVirtualI * virtualVertexCount + neighborVirtualJ

          const avgHeight =
            (myOriginal[myIdx] + neighborOriginal[neighborIdx]) / 2
          blendedMap[myIdx] = avgHeight
        }
      }
    }

    // East border (j = segments)
    const eastNeighbor = this.neighbors[NeighborDirection.East]
    if (eastNeighbor) {
      const neighborOriginal = eastNeighbor.getOriginalHeightMap()
      if (neighborOriginal) {
        for (let i = 0; i <= segments; i++) {
          const myIdx =
            (i + overlapSegments) * virtualVertexCount +
            (segments + overlapSegments)
          const neighborVirtualI = i + overlapSegments
          const neighborVirtualJ = 0 + overlapSegments
          const neighborIdx =
            neighborVirtualI * virtualVertexCount + neighborVirtualJ

          const avgHeight =
            (myOriginal[myIdx] + neighborOriginal[neighborIdx]) / 2
          blendedMap[myIdx] = avgHeight
        }
      }
    }

    // Corner vertices need special handling (average of up to 4 tiles)
    this.ensureCornerMatch(blendedMap, myOriginal, 0, 0) // NW corner
    this.ensureCornerMatch(blendedMap, myOriginal, 0, segments) // NE corner
    this.ensureCornerMatch(blendedMap, myOriginal, segments, 0) // SW corner
    this.ensureCornerMatch(blendedMap, myOriginal, segments, segments) // SE corner
  }

  // Ensure corner vertex matches with all adjacent tiles
  private ensureCornerMatch(
    blendedMap: Float32Array,
    myOriginal: Float32Array,
    i: number,
    j: number
  ): void {
    const { segments, overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount

    const myIdx =
      (i + overlapSegments) * virtualVertexCount + (j + overlapSegments)

    const heights: number[] = [myOriginal[myIdx]]

    // Determine which corner and get relevant neighbors
    const isNorth = i === 0
    const isSouth = i === segments
    const isWest = j === 0
    const isEast = j === segments

    // Cardinal neighbors
    if (isNorth) {
      const neighbor = this.neighbors[NeighborDirection.North]
      if (neighbor) {
        const neighborOriginal = neighbor.getOriginalHeightMap()
        if (neighborOriginal) {
          const ni = segments + overlapSegments
          const nj = j + overlapSegments
          heights.push(neighborOriginal[ni * virtualVertexCount + nj])
        }
      }
    }
    if (isSouth) {
      const neighbor = this.neighbors[NeighborDirection.South]
      if (neighbor) {
        const neighborOriginal = neighbor.getOriginalHeightMap()
        if (neighborOriginal) {
          const ni = 0 + overlapSegments
          const nj = j + overlapSegments
          heights.push(neighborOriginal[ni * virtualVertexCount + nj])
        }
      }
    }
    if (isWest) {
      const neighbor = this.neighbors[NeighborDirection.West]
      if (neighbor) {
        const neighborOriginal = neighbor.getOriginalHeightMap()
        if (neighborOriginal) {
          const ni = i + overlapSegments
          const nj = segments + overlapSegments
          heights.push(neighborOriginal[ni * virtualVertexCount + nj])
        }
      }
    }
    if (isEast) {
      const neighbor = this.neighbors[NeighborDirection.East]
      if (neighbor) {
        const neighborOriginal = neighbor.getOriginalHeightMap()
        if (neighborOriginal) {
          const ni = i + overlapSegments
          const nj = 0 + overlapSegments
          heights.push(neighborOriginal[ni * virtualVertexCount + nj])
        }
      }
    }

    // Diagonal neighbor for corners
    let diagonalDir: NeighborDirection | null = null
    let diagI = 0
    let diagJ = 0

    if (isNorth && isWest) {
      diagonalDir = NeighborDirection.NorthWest
      diagI = segments + overlapSegments
      diagJ = segments + overlapSegments
    } else if (isNorth && isEast) {
      diagonalDir = NeighborDirection.NorthEast
      diagI = segments + overlapSegments
      diagJ = 0 + overlapSegments
    } else if (isSouth && isWest) {
      diagonalDir = NeighborDirection.SouthWest
      diagI = 0 + overlapSegments
      diagJ = segments + overlapSegments
    } else if (isSouth && isEast) {
      diagonalDir = NeighborDirection.SouthEast
      diagI = 0 + overlapSegments
      diagJ = 0 + overlapSegments
    }

    if (diagonalDir !== null) {
      const neighbor = this.neighbors[diagonalDir]
      if (neighbor) {
        const neighborOriginal = neighbor.getOriginalHeightMap()
        if (neighborOriginal) {
          heights.push(neighborOriginal[diagI * virtualVertexCount + diagJ])
        }
      }
    }

    // Average all heights for exact corner match
    if (heights.length > 1) {
      const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length
      blendedMap[myIdx] = avgHeight
    }
  }

  // Update geometry after blending
  public updateGeometryAfterBlend(): void {
    if (!this.mesh || !this.heightMap) return

    const { segments, overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount
    const visibleVertexCount = segments + 1

    // Get position attribute
    const positionAttribute = this.mesh.geometry.getAttribute('position')
    if (!positionAttribute) return

    const positions = positionAttribute.array as Float32Array

    // Update Y values
    for (let i = 0; i < visibleVertexCount; i++) {
      for (let j = 0; j < visibleVertexCount; j++) {
        const virtualI = i + overlapSegments
        const virtualJ = j + overlapSegments
        const y = this.heightMap[virtualI * virtualVertexCount + virtualJ]

        const vertexIndex = (i * visibleVertexCount + j) * 3
        positions[vertexIndex + 1] = y
      }
    }

    positionAttribute.needsUpdate = true

    // Compute normals with neighbor awareness for smooth borders
    // Uncomment below line and comment computeVertexNormals() for smooth tile borders:
    // this.computeNormalsWithNeighbors()
    this.mesh.geometry.computeVertexNormals()

    // Clear geometry cache for this tile since it's been modified
    geometryCache.delete(`${this.key}_visible`)
  }

  // Get height at grid position from blended heightmap
  private getBlendedHeight(i: number, j: number): number {
    const { overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount
    const virtualI = i + overlapSegments
    const virtualJ = j + overlapSegments

    if (!this.heightMap) return 0
    return this.heightMap[virtualI * virtualVertexCount + virtualJ]
  }

  // Get height from neighbor's blended heightmap at their grid position
  private getNeighborBlendedHeight(
    neighbor: MapTile,
    neighborI: number,
    neighborJ: number
  ): number | null {
    if (!neighbor.heightMap) return null

    const { overlapSegments } = neighbor.config
    const virtualVertexCount = neighbor.virtualVertexCount
    const virtualI = neighborI + overlapSegments
    const virtualJ = neighborJ + overlapSegments

    if (
      virtualI < 0 ||
      virtualI >= virtualVertexCount ||
      virtualJ < 0 ||
      virtualJ >= virtualVertexCount
    ) {
      return null
    }

    return neighbor.heightMap[virtualI * virtualVertexCount + virtualJ]
  }

  /**
   * Compute vertex normals with awareness of neighbor tiles for smooth borders.
   * Call this instead of computeVertexNormals() for seamless tile borders.
   */
  public computeNormalsWithNeighbors(): void {
    if (!this.mesh || !this.heightMap) return

    const { segments } = this.config
    const visibleVertexCount = segments + 1
    const segmentSize = this.config.size / segments

    // Get or create normal attribute
    let normalAttribute = this.mesh.geometry.getAttribute('normal')
    if (!normalAttribute) {
      const normals = new Float32Array(
        visibleVertexCount * visibleVertexCount * 3
      )
      normalAttribute = new THREE.BufferAttribute(normals, 3)
      this.mesh.geometry.setAttribute('normal', normalAttribute)
    }

    const normals = normalAttribute.array as Float32Array

    // Temporary vectors for calculations
    const normal = new THREE.Vector3()
    const v0 = new THREE.Vector3()
    const v1 = new THREE.Vector3()
    const v2 = new THREE.Vector3()
    const edge1 = new THREE.Vector3()
    const edge2 = new THREE.Vector3()
    const faceNormal = new THREE.Vector3()

    // For each vertex, compute the normal by averaging adjacent face normals
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        normal.set(0, 0, 0)

        // Get height at this vertex and its neighbors
        // We need heights for a 3x3 grid centered on (i, j)
        const heights: (number | null)[][] = []

        for (let di = -1; di <= 1; di++) {
          heights[di + 1] = []
          for (let dj = -1; dj <= 1; dj++) {
            const ni = i + di
            const nj = j + dj

            heights[di + 1][dj + 1] = this.getHeightWithNeighborFallback(ni, nj)
          }
        }

        // Calculate normals for up to 8 adjacent triangles
        // Each quad has 2 triangles, vertex can be part of up to 4 quads
        const faceNormals: THREE.Vector3[] = []

        // Helper to add face normal if all heights are valid
        const addFaceNormal = (
          h0: number | null,
          h1: number | null,
          h2: number | null,
          x0: number,
          z0: number,
          x1: number,
          z1: number,
          x2: number,
          z2: number
        ) => {
          if (h0 === null || h1 === null || h2 === null) return

          v0.set(x0 * segmentSize, h0, z0 * segmentSize)
          v1.set(x1 * segmentSize, h1, z1 * segmentSize)
          v2.set(x2 * segmentSize, h2, z2 * segmentSize)

          edge1.subVectors(v1, v0)
          edge2.subVectors(v2, v0)
          faceNormal.crossVectors(edge1, edge2).normalize()

          if (faceNormal.y < 0) faceNormal.negate()

          faceNormals.push(faceNormal.clone())
        }

        // Center height
        const hC = heights[1][1]
        if (hC === null) continue

        // Neighbor heights
        const hN = heights[0][1] // North (i-1)
        const hS = heights[2][1] // South (i+1)
        const hW = heights[1][0] // West (j-1)
        const hE = heights[1][2] // East (j+1)
        const hNW = heights[0][0]
        const hNE = heights[0][2]
        const hSW = heights[2][0]
        const hSE = heights[2][2]

        // Triangle in NW quad (upper-left): vertices at (i-1,j-1), (i-1,j), (i,j)
        addFaceNormal(hNW, hN, hC, -1, -1, 0, -1, 0, 0)
        // Triangle in NW quad (lower-right): vertices at (i-1,j-1), (i,j), (i,j-1)
        addFaceNormal(hNW, hC, hW, -1, -1, 0, 0, -1, 0)

        // Triangle in NE quad: vertices at (i-1,j), (i-1,j+1), (i,j+1)
        addFaceNormal(hN, hNE, hE, 0, -1, 1, -1, 1, 0)
        // Triangle in NE quad: vertices at (i-1,j), (i,j+1), (i,j)
        addFaceNormal(hN, hE, hC, 0, -1, 1, 0, 0, 0)

        // Triangle in SW quad: vertices at (i,j-1), (i,j), (i+1,j)
        addFaceNormal(hW, hC, hS, -1, 0, 0, 0, 0, 1)
        // Triangle in SW quad: vertices at (i,j-1), (i+1,j), (i+1,j-1)
        addFaceNormal(hW, hS, hSW, -1, 0, 0, 1, -1, 1)

        // Triangle in SE quad: vertices at (i,j), (i,j+1), (i+1,j+1)
        addFaceNormal(hC, hE, hSE, 0, 0, 1, 0, 1, 1)
        // Triangle in SE quad: vertices at (i,j), (i+1,j+1), (i+1,j)
        addFaceNormal(hC, hSE, hS, 0, 0, 1, 1, 0, 1)

        // Average all face normals
        if (faceNormals.length > 0) {
          for (const fn of faceNormals) {
            normal.add(fn)
          }
          normal.normalize()
        } else {
          normal.set(0, 1, 0) // Default up
        }

        // Store normal
        const vertexIndex = (i * visibleVertexCount + j) * 3
        normals[vertexIndex] = normal.x
        normals[vertexIndex + 1] = normal.y
        normals[vertexIndex + 2] = normal.z
      }
    }

    normalAttribute.needsUpdate = true
  }

  // Get height at grid position, falling back to neighbors if outside our bounds
  private getHeightWithNeighborFallback(i: number, j: number): number | null {
    const { segments } = this.config

    // If within our visible area, use our heightmap
    if (i >= 0 && i <= segments && j >= 0 && j <= segments) {
      return this.getBlendedHeight(i, j)
    }

    // Otherwise, try to get from neighbor
    // Determine which neighbor to query
    let neighbor: MapTile | null = null
    let neighborI = i
    let neighborJ = j

    if (i < 0 && j >= 0 && j <= segments) {
      // North neighbor
      neighbor = this.neighbors[NeighborDirection.North]
      neighborI = i + segments
      neighborJ = j
    } else if (i > segments && j >= 0 && j <= segments) {
      // South neighbor
      neighbor = this.neighbors[NeighborDirection.South]
      neighborI = i - segments
      neighborJ = j
    } else if (j < 0 && i >= 0 && i <= segments) {
      // West neighbor
      neighbor = this.neighbors[NeighborDirection.West]
      neighborI = i
      neighborJ = j + segments
    } else if (j > segments && i >= 0 && i <= segments) {
      // East neighbor
      neighbor = this.neighbors[NeighborDirection.East]
      neighborI = i
      neighborJ = j - segments
    } else if (i < 0 && j < 0) {
      // NorthWest corner
      neighbor = this.neighbors[NeighborDirection.NorthWest]
      neighborI = i + segments
      neighborJ = j + segments
    } else if (i < 0 && j > segments) {
      // NorthEast corner
      neighbor = this.neighbors[NeighborDirection.NorthEast]
      neighborI = i + segments
      neighborJ = j - segments
    } else if (i > segments && j < 0) {
      // SouthWest corner
      neighbor = this.neighbors[NeighborDirection.SouthWest]
      neighborI = i - segments
      neighborJ = j + segments
    } else if (i > segments && j > segments) {
      // SouthEast corner
      neighbor = this.neighbors[NeighborDirection.SouthEast]
      neighborI = i - segments
      neighborJ = j - segments
    }

    if (neighbor) {
      return this.getNeighborBlendedHeight(neighbor, neighborI, neighborJ)
    }

    return null
  }

  // Mark tile as needing blending (called when neighbor loads)
  public markNeedsBlending(): void {
    this.blendVersion++
    this.needsBlending = true
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
    blendedHeightMapCache.delete(this.key)
    geometryCache.delete(`${this.key}_visible`)
    geometryCache.delete(`${this.key}_overlapGeo`)

    this.heightMap = null
    this.geometry = null
    this.overlapGeometry = null
    this.isLoaded = false
    this.needsBlending = true
    this.lastBlendVersion = -1

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
    blendedHeightMapCache.clear()
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
