import { fillMatrix2WithInterpolation } from '../utils'
import { Erosion, type ErosionResult } from '../utils/erosion'
import { PerlinNoise } from '../utils/perlin-noise'
import {
  DEFAULT_CARTOON_CONFIG,
  DEFAULT_OUTLINE_CONFIG,
  DEFAULT_SHADING_CONFIG,
  createCartoonMaterial,
  createOutlineMaterial,
  setCartoonLightDirection,
  updateCartoonMaterial,
  updateOutlineMaterial,
} from './CartoonMaterial'
import type {
  CartoonConfig,
  CartoonOutlineConfig,
  CartoonShadingConfig,
} from './CartoonMaterial'
import {
  DEFAULT_TERRAIN_PAINTER_CONFIG,
  TerrainPainter,
} from './terrain-painter'
import type { TerrainPainterConfig } from './terrain-painter'
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
  map: Float32Array
  width: number
  sizeScale: number
  size: number // World size of tile
  segments: number // Number of segments per side (visible)
  noiseScale: number // Scale for noise generation
  heightScale: number // Height multiplier
  seed: number // Seed for noise
  erosion: ErosionConfig // Erosion settings
  overlapSegments: number // Number of overlap segments on each side
  showOverlap: boolean // Whether to render overlap area (for debugging)
  painter: TerrainPainterConfig // Terrain painting configuration
  cartoon: CartoonConfig // Cartoon shader configuration
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
  map: new Float32Array(0),
  width: 1,
  sizeScale: 1,
  size: 32,
  segments: 64,
  noiseScale: 8,
  heightScale: 4,
  seed: 12345,
  erosion: DEFAULT_EROSION_CONFIG,
  overlapSegments: 4,
  showOverlap: false,
  painter: DEFAULT_TERRAIN_PAINTER_CONFIG,
  cartoon: DEFAULT_CARTOON_CONFIG,
}

// Cache for heightmaps to avoid regeneration (includes overlap)
const heightMapCache = new Map<string, Float32Array>()

// Cache for eroded heightmaps (separate from raw heightmaps)
const erodedHeightMapCache = new Map<string, Float32Array>()

// Cache for blended heightmaps (after neighbor blending)
const blendedHeightMapCache = new Map<string, Float32Array>()

// Cache for erosion results (erosion/deposit/flow maps)
const erosionResultCache = new Map<string, ErosionResult>()

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
let sharedMaterial: THREE.MeshToonMaterial | null = null
let sharedOverlapMaterial: THREE.MeshStandardMaterial | null = null
let sharedCartoonMaterial: THREE.MeshToonMaterial | null = null
let sharedOutlineMaterial: THREE.ShaderMaterial | null = null

// Current cartoon config for shared materials
let currentCartoonConfig: CartoonConfig = DEFAULT_CARTOON_CONFIG

function getSharedMaterial(): THREE.MeshToonMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshToonMaterial({ vertexColors: true })

    sharedMaterial.onBeforeCompile = (shader) => {
      // Сохраняем ссылку на шейдер, чтобы мы могли менять uniforms позже
      // --- ДОБАВЛЕНИЕ UNIFORMS ---
      // Добавляем наши переменные в шейдер
      shader.uniforms.uLevel = { value: -0.3 } // Высота линии
      shader.uniforms.uThickness = { value: 0.15 } // Толщина линии
      shader.uniforms.uOutlineColor = { value: new THREE.Color(0x000000) } // Цвет линии

      // --- ВЕРШИННЫЙ ШЕДЕР (VERTEX SHADER) ---
      // Нам нужно передать мировые координаты во фрагментный шейдер.
      // Мы объявляем varying и вычисляем позицию.

      shader.vertexShader = `
        varying vec3 vWorldPosition;
        ${shader.vertexShader}
    `

      // Вставляем вычисление позиции после стандартных трансформаций Three.js
      // Мы заменяем блок #include <begin_vertex>, чтобы добавить расчет vWorldPosition
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        // Вычисляем мировую позицию вершины
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        vWorldPosition = worldPosition.xyz;
        `
      )

      // --- ФРАГМЕНТНЫЙ ШЕДЕР (FRAGMENT SHADER) ---
      // Добавляем объявление uniform и varying

      shader.fragmentShader = `
        uniform float uLevel;
        uniform float uThickness;
        uniform vec3 uOutlineColor;
        varying vec3 vWorldPosition;
        ${shader.fragmentShader}
    `

      // Внедряем логику отрисовки линии в самом конце шейдера
      // #include <dithering_fragment> — это обычно последний шаг перед выводом цвета
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        
        // Логика линии уровня
        float dist = abs(vWorldPosition.y - uLevel);
        float lineAlpha = 1.0 - smoothstep(0.0, uThickness, dist);
        
        // Смешиваем цвет Toon материала (gl_FragColor) с цветом линии
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uOutlineColor, lineAlpha);
        `
      )
    }
  }

  return sharedMaterial

  // if (!sharedMaterial) {
  //   sharedMaterial = new THREE.MeshStandardMaterial({
  //     vertexColors: true, // Enable vertex colors
  //     side: THREE.DoubleSide,
  //     wireframe: false,
  //     flatShading: false,
  //   })
  // }
  // return sharedMaterial
}

function getTreeMaterial(): THREE.MeshToonMaterial {
  if (!sharedCartoonMaterial) {
    sharedCartoonMaterial = new THREE.MeshToonMaterial({
      color: 0xf2b705,
      side: THREE.DoubleSide,
    })

    // sharedCartoonMaterial = new THREE.MeshStandardMaterial({
    //   color: 0x00ff00,
    //   side: THREE.DoubleSide,
    //   wireframe: false,
    //   flatShading: false,
    // })

    // sharedCartoonMaterial = createCartoonMaterial(config)
    // currentCartoonConfig.shading = config
  }
  return sharedCartoonMaterial
}

function getSharedOutlineMaterial(
  config: CartoonOutlineConfig = DEFAULT_OUTLINE_CONFIG
): THREE.ShaderMaterial {
  if (!sharedOutlineMaterial) {
    sharedOutlineMaterial = createOutlineMaterial(config)
    currentCartoonConfig.outline = config
  }
  return sharedOutlineMaterial
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

  public static overLapWeight: Float32Array
  public static blendArr: Array<Array<Array<number>>> = []

  public static indices: Float32Array

  private treeMap: Float32Array = new Float32Array()

  public static initIndices = (config: TileConfig) => {
    const { segments } = config
    const seg = segments + 2
    const visibleVertexCount = seg + 1

    const indices = new Uint32Array(seg * seg * 6)
    let indexOffset = 0

    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < seg; j++) {
        const index = i * visibleVertexCount + j
        const a = index
        const b = index + 1
        const c = index + visibleVertexCount
        const d = index + visibleVertexCount + 1

        if (index % 2 === 0) {
          indices[indexOffset++] = a
          indices[indexOffset++] = d
          indices[indexOffset++] = b

          indices[indexOffset++] = a
          indices[indexOffset++] = c
          indices[indexOffset++] = d
        } else {
          indices[indexOffset++] = c
          indices[indexOffset++] = b
          indices[indexOffset++] = a

          indices[indexOffset++] = c
          indices[indexOffset++] = d
          indices[indexOffset++] = b
        }
      }
    }

    MapTile.indices = new Float32Array(indices)
  }

  public static initOverLapIndexes = (config: TileConfig) => {
    const size = config.segments + 2 * config.overlapSegments + 1
    const x0 = Math.floor(size / 2)
    const z0 = x0

    const noise = new PerlinNoise(123)

    MapTile.overLapWeight = new Float32Array(size ** 2)
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        let dist = Math.sqrt((x0 - x) ** 2 + (z0 - z) ** 2)

        const h = noise.fractalNoise2D(x, z) / 4

        if (dist > x0) {
          dist = 0
          continue
        }
        MapTile.overLapWeight[z * size + x] = (x0 - dist) / (x0 + 0.25) + h
      }
    }

    const neibBorders = []
    for (let i = 0; i < 8; i++) {
      neibBorders.push(new Int32Array(size ** 2).fill(-1))
    }

    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i++) {
      const cur = NEIGHBOR_OFFSETS[i]
      for (let z = 0; z < size; z++) {
        const nZ =
          z + (size - 1) * -cur[1] - config.overlapSegments * 2 * -cur[1]
        if (nZ < 0 || nZ >= size) continue
        for (let x = 0; x < size; x++) {
          const nX =
            x + (size - 1) * -cur[0] - config.overlapSegments * 2 * -cur[0]
          if (nX < 0 || nX >= size) continue

          neibBorders[i][z * size + x] = nZ * size + nX
        }
      }
    }

    // neighbor, neighbor height index, weight
    const arr: Array<Array<Array<number>>> = []
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const box = []
        const index = z * size + x
        for (let i = 0; i < neibBorders.length; i++) {
          if (neibBorders[i][index] > -1) {
            const weight = this.overLapWeight[neibBorders[i][index]]
            if (weight === 0) continue
            box.push([i, neibBorders[i][index], weight])
          }
        }
        arr.push(box)
      }
    }
    MapTile.blendArr = arr
  }

  // Configuration
  private config: TileConfig

  // Three.js objects
  private mesh: THREE.Mesh | null = null
  private outlineMesh: THREE.Mesh | null = null
  private overlapMesh: THREE.Mesh | null = null
  private geometry: THREE.BufferGeometry | null = null
  private overlapGeometry: THREE.BufferGeometry | null = null

  // Heightmap data (cached, includes overlap)
  private heightMap: Float32Array | null = null

  // Mask for noise end erosion
  private maskHeight: Float32Array = new Float32Array(0)

  // Mask average
  private maskAvg: number = 0

  // Erosion result data (for terrain painting)
  private erosionResult: ErosionResult | null = null

  // Terrain painter instance
  private painter: TerrainPainter

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
    this.painter = new TerrainPainter(config.painter)
    this.getHeightDelt()
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

  /**
   * Get the terrain painter instance
   */
  public getPainter(): TerrainPainter {
    return this.painter
  }

  /**
   * Update terrain painter configuration
   */
  public setPainterConfig(config: Partial<TerrainPainterConfig>): void {
    this.painter.setConfig(config)
    // Mark for re-painting if loaded
    if (this.isLoaded && this.mesh) {
      this.repaintTerrain()
    }
  }

  /**
   * Get the erosion result data (erosion, deposit, flow maps)
   */
  public getErosionResult(): ErosionResult | null {
    return this.erosionResult
  }

  /**
   * Repaint terrain with current painter settings
   */
  public repaintTerrain(): void {
    if (!this.mesh || !this.heightMap) return

    const { segments, overlapSegments } = this.config
    const virtualVertexCount = this.virtualVertexCount

    const normals = this.mesh.geometry.getAttribute('normal')
      ?.array as Float32Array | null
    const visibleErosionResult = this.extractVisibleErosionResult()
    const visibleHeightMap = this.extractVisibleHeightMap(
      this.heightMap,
      segments,
      overlapSegments,
      virtualVertexCount
    )

    const colors = this.painter.calculateVertexColors(
      visibleHeightMap,
      normals,
      visibleErosionResult,
      segments,
      this.config.heightScale
    )

    this.mesh.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colors, 3)
    )
  }

  private getHeightDelt() {
    const x =
      (this.tileX + this.config.width / (2 * this.config.sizeScale)) *
      this.config.sizeScale
    const y =
      (this.tileZ + this.config.width / (2 * this.config.sizeScale)) *
      this.config.sizeScale

    this.maskHeight = new Float32Array(this.virtualVertexCount ** 2)

    if (x < 0 || y < 0 || x > this.config.width || y > this.config.width) {
      for (let i = 0; i < this.maskHeight.length; i++) {
        this.maskHeight[i] = 0
      }
      this.maskAvg = 0

      return
    }

    fillMatrix2WithInterpolation(
      this.config.map,
      this.config.width,
      this.maskHeight,
      this.virtualVertexCount,
      x,
      y,
      this.config.sizeScale
    )

    for (let i = 0; i < this.maskHeight.length; i++) {
      this.maskAvg += this.maskHeight[i]
    }
    this.maskAvg /= this.maskHeight.length
  }

  // Generate raw heightmap without erosion (cached, includes overlap)
  private generateRawHeightMap(): Float32Array {
    if (this.maskAvg === 0) {
      return new Float32Array(this.virtualVertexCount ** 2).fill(0)
    }
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

        const index = i * virtualVertexCount + j
        if (this.maskHeight[index] < 0.1) {
          heightMap[index] = -1
          continue
        }

        // Use world coordinates for seamless noise
        const height =
          ((noise.fractalNoise2D(x / noiseScale, z / noiseScale) + 1) / 2) *
          heightScale

        // heightMap[index] = height

        heightMap[index] =
          this.maskHeight[index] * 8 + height * this.maskHeight[index]

        // heightMap[index] = height * this.maskHeight[index] * 1.5
        // if (heightMap[index] < 0.01) {
        //   heightMap[index] = 0
        // }
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
    const cachedErosionResult = erosionResultCache.get(this.key)
    if (cachedEroded && cachedErosionResult) {
      this.erosionResult = cachedErosionResult
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
    // This now returns the erosion result with erosion/deposit/flow maps
    this.erosionResult = erosion.erode(
      erodedMap,
      virtualVertexCount,
      virtualVertexCount,
      erosionConfig.iterations * this.maskAvg
    )

    // Cache the eroded heightmap and erosion result
    erodedHeightMapCache.set(this.key, erodedMap)
    erosionResultCache.set(this.key, this.erosionResult)

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

  // Blend heightmap with neighbors at borders - EXACT vertex matching
  public blendWithNeighbors(): boolean {
    if (!this.heightMap || !this.isLoaded) return false
    if (this.blendVersion === this.lastBlendVersion) return false

    const { overlapSegments } = this.config
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

    const blendedMap = new Float32Array(myOriginal)

    const neibArr: Array<Float32Array> = []
    for (let i = 0; i < this.neighbors.length; i++) {
      if (!this.neighbors[i]) return false

      const arr = this.neighbors[i]?.getOriginalHeightMap()
      if (!arr) return false
      neibArr.push(arr)
    }

    for (let i = 0; i < myOriginal.length; i++) {
      let up = myOriginal[i] * MapTile.overLapWeight[i]
      if (up === 0) continue
      let down = MapTile.overLapWeight[i]
      for (let j = 0; j < MapTile.blendArr[i].length; j++) {
        const cur = MapTile.blendArr[i][j]

        up += neibArr[cur[0]][cur[1]] * cur[2]
        down += cur[2]
      }

      blendedMap[i] = up / down
    }

    blendedHeightMapCache.set(this.key, blendedMap)
    this.heightMap = blendedMap

    this.needsBlending = false
    this.lastBlendVersion = this.blendVersion

    if (this.mesh) {
      this.mesh.visible = true
    }

    return true
  }

  private createTreeMap(treeIndex: number) {
    if (!this.mesh || !this.heightMap || !this.mesh.visible) return

    const vertPerTree = 4
    const vertices = new Float32Array(treeIndex * vertPerTree)

    const indicesLength = treeIndex * 9
    const indices = new Uint32Array(indicesLength)

    let tCount = 0
    for (let i = 0; i < indicesLength; i++) {
      const a = tCount
      const b = tCount + 1
      const c = tCount + 2
      const o = tCount + 3

      indices[i++] = a
      indices[i++] = o
      indices[i++] = b

      indices[i++] = b
      indices[i++] = o
      indices[i++] = c

      indices[i++] = c
      indices[i++] = o
      indices[i] = a

      tCount += vertPerTree
    }

    let vertCount = 0
    for (let i = 0; i < treeIndex; i += 3) {
      // A
      vertices[vertCount++] = this.treeMap[i] - 1.5
      vertices[vertCount++] = this.treeMap[i + 1] - 0.2
      vertices[vertCount++] = this.treeMap[i + 2]

      // B
      vertices[vertCount++] = this.treeMap[i] + 1.5
      vertices[vertCount++] = this.treeMap[i + 1] - 0.2
      vertices[vertCount++] = this.treeMap[i + 2]

      // C
      vertices[vertCount++] = this.treeMap[i]
      vertices[vertCount++] = this.treeMap[i + 1] - 0.2
      vertices[vertCount++] = this.treeMap[i + 2] + 3

      // O
      vertices[vertCount++] = this.treeMap[i]
      vertices[vertCount++] = this.treeMap[i + 1] + 3.5
      vertices[vertCount++] = this.treeMap[i + 2] + 1.5
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeVertexNormals()

    const material = getTreeMaterial()

    let mesh = new THREE.Mesh(geometry, material)
    // console.log(mesh)

    this.mesh.add(mesh)
  }

  // Update geometry after blending
  public updateGeometryAfterBlend(): void {
    if (!this.mesh || !this.heightMap) return

    const { segments, overlapSegments } = this.config
    const seg = segments + 2
    const virtualVertexCount = this.virtualVertexCount
    const visibleVertexCount = seg + 1

    // Get position attribute
    const positionAttribute = this.mesh.geometry.getAttribute('position')
    if (!positionAttribute) return

    const positions = positionAttribute.array as Float32Array

    this.treeMap = new Float32Array(positions.length)
    let treeIndex = 0
    const min = 3
    const max = 8

    const noise = new PerlinNoise(98742)
    const segmentSize = this.config.size / this.config.segments

    // Update Y values
    for (let i = 0; i < visibleVertexCount; i++) {
      const z = this.virtualWorldZ + i * segmentSize
      for (let j = 0; j < visibleVertexCount; j++) {
        const virtualI = i + overlapSegments - 1
        const virtualJ = j + overlapSegments - 1
        const y = this.heightMap[virtualI * virtualVertexCount + virtualJ]
        const x = this.virtualWorldX + j * segmentSize

        const vertexIndex = (i * visibleVertexCount + j) * 3
        positions[vertexIndex + 1] = y

        const noiseValue = noise.fractalNoise2D(
          x / this.config.noiseScale / 2,
          z / this.config.noiseScale / 2
        )

        if (
          min < y &&
          y < max &&
          0.05 < noiseValue &&
          (virtualI % 2 !== 0 || virtualJ % 2 !== 0)
        ) {
          this.treeMap[treeIndex++] = positions[vertexIndex]
          this.treeMap[treeIndex++] = positions[vertexIndex + 1]
          this.treeMap[treeIndex++] = positions[vertexIndex + 2]
        }
      }
    }

    this.createTreeMap(treeIndex)

    this.mesh.geometry.computeVertexNormals()

    for (let i = 0; i < visibleVertexCount; i++) {
      for (let j = 0; j < visibleVertexCount; j++) {
        const vertexIndex = (i * visibleVertexCount + j) * 3
        if (
          i == 0 ||
          j == 0 ||
          i == visibleVertexCount - 1 ||
          j == visibleVertexCount - 1
        ) {
          if (positions[vertexIndex + 1] < 0.2) {
            positions[vertexIndex + 1] -= 5
          } else {
            positions[vertexIndex + 1] -= 0.01
          }
        }
      }
    }

    positionAttribute.needsUpdate = true

    // Recalculate vertex colors after blending
    const normals = this.mesh.geometry.getAttribute('normal')
      ?.array as Float32Array | null
    const visibleErosionResult = this.extractVisibleErosionResult()
    const visibleHeightMap = this.extractVisibleHeightMap(
      this.heightMap,
      seg,
      overlapSegments,
      virtualVertexCount
    )

    const colors = this.painter.calculateVertexColors(
      visibleHeightMap,
      normals,
      visibleErosionResult,
      seg,
      this.config.heightScale
    )

    this.mesh.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(colors, 3)
    )

    // Clear geometry cache for this tile since it's been modified
    geometryCache.delete(`${this.key}_visible`)
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
    const seg = segments + 2
    const virtualVertexCount = this.virtualVertexCount
    const visibleVertexCount = seg + 1

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
        const virtualI = i + overlapSegments - 1
        const virtualJ = j + overlapSegments - 1
        const y = heightMap[virtualI * virtualVertexCount + virtualJ]

        vertices[vertexIndex++] = x
        vertices[vertexIndex++] = y
        vertices[vertexIndex++] = z
      }
    }

    // Create indices
    const indices = new Uint32Array(MapTile.indices)

    // Create geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeVertexNormals()

    // Calculate and apply vertex colors
    const normals = geometry.getAttribute('normal')
      ?.array as Float32Array | null

    // Extract visible portion of erosion data for painting
    const visibleErosionResult = this.extractVisibleErosionResult()

    const colors = this.painter.calculateVertexColors(
      this.extractVisibleHeightMap(
        heightMap,
        seg,
        overlapSegments,
        virtualVertexCount
      ),
      normals,
      visibleErosionResult,
      seg,
      this.config.heightScale
    )
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // Cache geometry
    geometryCache.set(cacheKey, geometry)

    return geometry
  }

  // Extract visible portion of heightmap for painting
  private extractVisibleHeightMap(
    fullHeightMap: Float32Array,
    segments: number,
    overlapSegments: number,
    virtualVertexCount: number
  ): Float32Array {
    const visibleVertexCount = segments + 1
    const visibleHeightMap = new Float32Array(
      visibleVertexCount * visibleVertexCount
    )

    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const virtualI = i + overlapSegments - 1
        const virtualJ = j + overlapSegments - 1
        const srcIdx = virtualI * virtualVertexCount + virtualJ
        const dstIdx = i * visibleVertexCount + j
        visibleHeightMap[dstIdx] = fullHeightMap[srcIdx]
      }
    }

    return visibleHeightMap
  }

  // Extract visible portion of erosion result for painting
  private extractVisibleErosionResult(): ErosionResult | null {
    if (!this.erosionResult) return null

    let { segments, overlapSegments } = this.config
    segments += 2
    const virtualVertexCount = this.virtualVertexCount
    const visibleVertexCount = segments + 1
    const visibleSize = visibleVertexCount * visibleVertexCount

    const visibleErosionMap = new Float32Array(visibleSize)
    const visibleDepositMap = new Float32Array(visibleSize)
    const visibleFlowMap = new Float32Array(visibleSize)

    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const virtualI = i + overlapSegments - 1
        const virtualJ = j + overlapSegments - 1
        const srcIdx = virtualI * virtualVertexCount + virtualJ
        const dstIdx = i * visibleVertexCount + j

        visibleErosionMap[dstIdx] = this.erosionResult.erosionMap[srcIdx]
        visibleDepositMap[dstIdx] = this.erosionResult.depositMap[srcIdx]
        visibleFlowMap[dstIdx] = this.erosionResult.flowMap[srcIdx]
      }
    }

    return {
      erosionMap: visibleErosionMap,
      depositMap: visibleDepositMap,
      flowMap: visibleFlowMap,
    }
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
    const x =
      (this.tileX + this.config.width / (2 * this.config.sizeScale)) *
      this.config.sizeScale
    const y =
      (this.tileZ + this.config.width / (2 * this.config.sizeScale)) *
      this.config.sizeScale

    if (x < 0 || y < 0 || x > this.config.width || y > this.config.width) return

    if (this.isLoaded || this.isGenerating) return

    this.isGenerating = true

    // Generate heightmap if not cached
    this.heightMap = this.generateHeightMap()

    // Try to get mesh from pool
    this.mesh = getMeshFromPool()

    // Generate visible geometry
    this.geometry = this.generateVisibleGeometry()

    // Choose material based on cartoon config
    const material = this.config.cartoon.enabled
      ? getTreeMaterial()
      : getSharedMaterial()

    if (this.mesh) {
      // Reuse pooled mesh
      this.mesh.geometry = this.geometry
      this.mesh.material = material
      this.mesh.position.set(this.worldX, 0, this.worldZ)
      this.mesh.visible = true
    } else {
      // Create new mesh
      this.mesh = new THREE.Mesh(this.geometry, material)
      this.mesh.position.set(this.worldX, 0, this.worldZ)
    }

    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    // this.mesh.userData.ignoreOutline = true

    // Add to scene if not already there
    if (!this.mesh.parent) {
      this.mesh.visible = false
      scene.add(this.mesh)
    }

    // Create outline mesh if cartoon mode is enabled with outline
    if (
      this.config.cartoon.enabled &&
      this.config.cartoon.outline.enabled &&
      this.geometry
    ) {
      const outlineMaterial = getSharedOutlineMaterial(
        this.config.cartoon.outline
      )
      this.outlineMesh = new THREE.Mesh(this.geometry, outlineMaterial)
      this.outlineMesh.position.set(this.worldX, 0, this.worldZ)
      this.outlineMesh.renderOrder = -1 // Render before main mesh
      this.outlineMesh.castShadow = false
      this.outlineMesh.receiveShadow = false
      scene.add(this.outlineMesh)
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

    if (this.outlineMesh) {
      if (this.outlineMesh.parent) {
        this.outlineMesh.parent.remove(this.outlineMesh)
      }
      // Don't dispose geometry as it's shared with main mesh
      this.outlineMesh = null
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

    if (this.outlineMesh) {
      if (this.outlineMesh.parent) {
        this.outlineMesh.parent.remove(this.outlineMesh)
      }
      // Don't dispose geometry as it's shared with main mesh
      this.outlineMesh = null
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
    erosionResultCache.clear()
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
    if (sharedCartoonMaterial) {
      sharedCartoonMaterial.dispose()
      sharedCartoonMaterial = null
    }
    if (sharedOutlineMaterial) {
      sharedOutlineMaterial.dispose()
      sharedOutlineMaterial = null
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

  /**
   * Get current cartoon configuration
   */
  public getCartoonConfig(): CartoonConfig {
    return { ...this.config.cartoon }
  }

  /**
   * Update cartoon shading configuration
   * This updates the shared material, affecting all tiles
   */
  public setCartoonShadingConfig(config: Partial<CartoonShadingConfig>): void {
    this.config.cartoon.shading = { ...this.config.cartoon.shading, ...config }
    if (sharedCartoonMaterial) {
      updateCartoonMaterial(sharedCartoonMaterial, config)
    }
  }

  /**
   * Update cartoon outline configuration
   * This updates the shared material, affecting all tiles
   */
  public setCartoonOutlineConfig(config: Partial<CartoonOutlineConfig>): void {
    this.config.cartoon.outline = { ...this.config.cartoon.outline, ...config }
    if (sharedOutlineMaterial) {
      updateOutlineMaterial(sharedOutlineMaterial, config)
    }
  }

  /**
   * Enable or disable cartoon mode
   * Note: This only affects new tiles or requires reload for existing tiles
   */
  public setCartoonEnabled(enabled: boolean, scene: THREE.Scene): void {
    if (this.config.cartoon.enabled === enabled) return

    this.config.cartoon.enabled = enabled

    if (this.isLoaded && this.mesh && this.geometry) {
      // Update material
      if (enabled) {
        this.mesh.material = getTreeMaterial()

        // Create outline mesh if needed
        if (this.config.cartoon.outline.enabled && !this.outlineMesh) {
          const outlineMaterial = getSharedOutlineMaterial(
            this.config.cartoon.outline
          )
          this.outlineMesh = new THREE.Mesh(this.geometry, outlineMaterial)
          this.outlineMesh.position.set(this.worldX, 0, this.worldZ)
          this.outlineMesh.renderOrder = -1
          this.outlineMesh.castShadow = false
          this.outlineMesh.receiveShadow = false
          scene.add(this.outlineMesh)
        }
      } else {
        this.mesh.material = getSharedMaterial()

        // Remove outline mesh
        if (this.outlineMesh) {
          if (this.outlineMesh.parent) {
            this.outlineMesh.parent.remove(this.outlineMesh)
          }
          this.outlineMesh = null
        }
      }
    }
  }

  /**
   * Enable or disable outline
   */
  public setOutlineEnabled(enabled: boolean, scene: THREE.Scene): void {
    if (this.config.cartoon.outline.enabled === enabled) return

    this.config.cartoon.outline.enabled = enabled

    if (this.isLoaded && this.config.cartoon.enabled && this.geometry) {
      if (enabled && !this.outlineMesh) {
        const outlineMaterial = getSharedOutlineMaterial(
          this.config.cartoon.outline
        )
        this.outlineMesh = new THREE.Mesh(this.geometry, outlineMaterial)
        this.outlineMesh.position.set(this.worldX, 0, this.worldZ)
        this.outlineMesh.renderOrder = -1
        this.outlineMesh.castShadow = false
        this.outlineMesh.receiveShadow = false
        scene.add(this.outlineMesh)
      } else if (!enabled && this.outlineMesh) {
        if (this.outlineMesh.parent) {
          this.outlineMesh.parent.remove(this.outlineMesh)
        }
        this.outlineMesh = null
      }
    }
  }

  /**
   * Set light direction for cartoon shading
   */
  public static setCartoonLightDirection(direction: THREE.Vector3): void {
    if (sharedCartoonMaterial) {
      setCartoonLightDirection(sharedCartoonMaterial, direction)
    }
  }

  /**
   * Get current shared cartoon material (for external access)
   */
  public static getTreeMaterial(): THREE.MeshStandardMaterial {
    return sharedCartoonMaterial
  }

  /**
   * Get current shared outline material (for external access)
   */
  public static getSharedOutlineMaterial(): THREE.ShaderMaterial | null {
    return sharedOutlineMaterial
  }
}
