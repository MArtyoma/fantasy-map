import { DEFAULT_TILE_CONFIG, MapTile, NeighborDirection } from './MapTile'
import type { TileConfig } from './MapTile'
import * as THREE from 'three'

export interface TileManagerConfig {
  tileConfig: TileConfig
  loadDistance: number // Distance in tiles to load
  unloadDistance: number // Distance in tiles to unload (should be > loadDistance)
  maxTilesPerFrame: number // Max tiles to load/unload per frame
  maxBlendsPerFrame: number // Max tiles to blend per frame
}

const DEFAULT_MANAGER_CONFIG: TileManagerConfig = {
  tileConfig: DEFAULT_TILE_CONFIG,
  loadDistance: 3,
  unloadDistance: 5,
  maxTilesPerFrame: 2,
  maxBlendsPerFrame: 2,
}

export class TileManager {
  private scene: THREE.Scene
  private config: TileManagerConfig

  // All tiles (loaded and cached)
  private tiles = new Map<string, MapTile>()

  // Tiles currently loaded in scene
  private loadedTiles = new Set<string>()

  // Pending operations (for frame budget)
  private pendingLoads: MapTile[] = []
  private pendingUnloads: MapTile[] = []

  // Pending blend operations (for smooth borders)
  private pendingBlends = new Set<string>()

  // Camera position tracking
  private lastCameraTileX = Infinity
  private lastCameraTileZ = Infinity

  // Performance metrics
  private loadedCount = 0
  private totalGenerated = 0

  constructor(scene: THREE.Scene, config: Partial<TileManagerConfig> = {}) {
    this.scene = scene
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config }

    if (config.tileConfig) {
      this.config.tileConfig = { ...DEFAULT_TILE_CONFIG, ...config.tileConfig }
    }
  }

  // Get tile key from coordinates
  private getTileKey(tileX: number, tileZ: number): string {
    return `${tileX}_${tileZ}`
  }

  // Get or create tile
  private getOrCreateTile(tileX: number, tileZ: number): MapTile {
    const key = this.getTileKey(tileX, tileZ)
    let tile = this.tiles.get(key)

    if (!tile) {
      tile = new MapTile(tileX, tileZ, this.config.tileConfig)
      this.tiles.set(key, tile)
      this.totalGenerated++

      // Connect to existing neighbors
      this.connectNeighbors(tile)
    }

    return tile
  }

  // Connect tile to its neighbors
  private connectNeighbors(tile: MapTile): void {
    for (let dir = 0; dir < 8; dir++) {
      const [nx, nz] = MapTile.getNeighborCoords(
        tile.tileX,
        tile.tileZ,
        dir as NeighborDirection
      )
      const neighborKey = this.getTileKey(nx, nz)
      const neighbor = this.tiles.get(neighborKey)

      if (neighbor) {
        // Connect both ways
        tile.setNeighbor(dir as NeighborDirection, neighbor)
        // Opposite direction
        const oppositeDir = ((dir + 4) % 8) as NeighborDirection
        neighbor.setNeighbor(oppositeDir, tile)
      }
    }
  }

  // Convert world position to tile coordinates
  public worldToTile(worldX: number, worldZ: number): [number, number] {
    const tileSize = this.config.tileConfig.size
    return [Math.floor(worldX / tileSize), Math.floor(worldZ / tileSize)]
  }

  // Update tiles based on camera position
  public update(cameraX: number, cameraZ: number): void {
    const [cameraTileX, cameraTileZ] = this.worldToTile(cameraX, cameraZ)

    // Only recalculate if camera moved to different tile
    if (
      cameraTileX !== this.lastCameraTileX ||
      cameraTileZ !== this.lastCameraTileZ
    ) {
      this.lastCameraTileX = cameraTileX
      this.lastCameraTileZ = cameraTileZ

      this.calculatePendingOperations(cameraTileX, cameraTileZ)
    }

    // Process pending operations within frame budget
    this.processPendingOperations()
  }

  // Calculate which tiles need to be loaded/unloaded
  private calculatePendingOperations(
    cameraTileX: number,
    cameraTileZ: number
  ): void {
    const { loadDistance, unloadDistance } = this.config
    const loadDistSq = loadDistance * loadDistance
    const unloadDistSq = unloadDistance * unloadDistance

    // Clear pending operations
    this.pendingLoads = []
    this.pendingUnloads = []

    // Find tiles to load
    for (let dz = -loadDistance; dz <= loadDistance; dz++) {
      for (let dx = -loadDistance; dx <= loadDistance; dx++) {
        const distSq = dx * dx + dz * dz
        if (distSq <= loadDistSq) {
          const tileX = cameraTileX + dx
          const tileZ = cameraTileZ + dz
          const key = this.getTileKey(tileX, tileZ)

          if (!this.loadedTiles.has(key)) {
            const tile = this.getOrCreateTile(tileX, tileZ)
            this.pendingLoads.push(tile)
          }
        }
      }
    }

    // Sort pending loads by distance (load closest first)
    this.pendingLoads.sort((a, b) => {
      const distA = (a.tileX - cameraTileX) ** 2 + (a.tileZ - cameraTileZ) ** 2
      const distB = (b.tileX - cameraTileX) ** 2 + (b.tileZ - cameraTileZ) ** 2
      return distA - distB
    })

    // Find tiles to unload
    for (const key of this.loadedTiles) {
      const tile = this.tiles.get(key)
      if (!tile) continue

      const dx = tile.tileX - cameraTileX
      const dz = tile.tileZ - cameraTileZ
      const distSq = dx * dx + dz * dz

      if (distSq > unloadDistSq) {
        this.pendingUnloads.push(tile)
      }
    }

    // Sort pending unloads by distance (unload farthest first)
    this.pendingUnloads.sort((a, b) => {
      const distA = (a.tileX - cameraTileX) ** 2 + (a.tileZ - cameraTileZ) ** 2
      const distB = (b.tileX - cameraTileX) ** 2 + (b.tileZ - cameraTileZ) ** 2
      return distB - distA
    })
  }

  // Process pending load/unload operations within frame budget
  private processPendingOperations(): void {
    const { maxTilesPerFrame, maxBlendsPerFrame } = this.config
    let operations = 0

    // Process unloads first (free memory)
    while (this.pendingUnloads.length > 0 && operations < maxTilesPerFrame) {
      const tile = this.pendingUnloads.shift()!
      this.unloadTile(tile)
      operations++
    }

    // Then process loads
    while (this.pendingLoads.length > 0 && operations < maxTilesPerFrame) {
      const tile = this.pendingLoads.shift()!
      this.loadTile(tile)
      operations++
    }

    // Process blending operations
    this.processBlendingQueue(maxBlendsPerFrame)
  }

  // Process the blending queue
  private processBlendingQueue(maxBlends: number): void {
    let blendCount = 0

    // Convert to array for iteration (we'll modify the set)
    const keysToProcess = Array.from(this.pendingBlends)

    for (const key of keysToProcess) {
      if (blendCount >= maxBlends) break

      const tile = this.tiles.get(key)
      if (!tile || !tile.loaded) {
        this.pendingBlends.delete(key)
        continue
      }

      // Check if tile still needs blending
      if (!tile.requiresBlending) {
        this.pendingBlends.delete(key)
        continue
      }

      // Perform blending
      const didBlend = tile.blendWithNeighbors()
      if (didBlend) {
        tile.updateGeometryAfterBlend()
        blendCount++
      }

      this.pendingBlends.delete(key)
    }
  }

  // Load a tile
  private loadTile(tile: MapTile): void {
    if (tile.loaded) return

    tile.load(this.scene)
    this.loadedTiles.add(tile.key)
    this.loadedCount++

    // Queue this tile and its neighbors for blending
    this.queueTileForBlending(tile)
  }

  // Queue a tile and its neighbors for blending
  private queueTileForBlending(tile: MapTile): void {
    // Queue this tile
    this.pendingBlends.add(tile.key)

    // Queue all loaded neighbors (they need to blend with this new tile)
    for (let dir = 0; dir < 8; dir++) {
      const neighbor = tile.getNeighbor(dir as NeighborDirection)
      if (neighbor && neighbor.loaded) {
        neighbor.markNeedsBlending()
        this.pendingBlends.add(neighbor.key)
      }
    }
  }

  // Unload a tile
  private unloadTile(tile: MapTile): void {
    if (!tile.loaded) return

    tile.unload()
    this.loadedTiles.delete(tile.key)
    this.loadedCount--
  }

  // Force load all tiles in range immediately (blocking)
  public forceLoadAll(cameraX: number, cameraZ: number): void {
    const [cameraTileX, cameraTileZ] = this.worldToTile(cameraX, cameraZ)
    const { loadDistance } = this.config
    const loadDistSq = loadDistance * loadDistance

    for (let dz = -loadDistance; dz <= loadDistance; dz++) {
      for (let dx = -loadDistance; dx <= loadDistance; dx++) {
        const distSq = dx * dx + dz * dz
        if (distSq <= loadDistSq) {
          const tile = this.getOrCreateTile(cameraTileX + dx, cameraTileZ + dz)
          this.loadTile(tile)
        }
      }
    }

    // Force blend all loaded tiles immediately
    this.forceBlendAll()

    this.lastCameraTileX = cameraTileX
    this.lastCameraTileZ = cameraTileZ
  }

  // Force blend all tiles that need blending (blocking)
  private forceBlendAll(): void {
    // Multiple passes to ensure all neighbors are considered
    for (let pass = 0; pass < 2; pass++) {
      for (const tile of this.tiles.values()) {
        if (tile.loaded && tile.requiresBlending) {
          const didBlend = tile.blendWithNeighbors()
          if (didBlend) {
            tile.updateGeometryAfterBlend()
          }
        }
      }
    }
    this.pendingBlends.clear()
  }

  // Get tile at world position
  public getTileAt(worldX: number, worldZ: number): MapTile | null {
    const [tileX, tileZ] = this.worldToTile(worldX, worldZ)
    return this.tiles.get(this.getTileKey(tileX, tileZ)) || null
  }

  // Get height at world position
  public getHeightAt(worldX: number, worldZ: number): number | null {
    const tile = this.getTileAt(worldX, worldZ)
    if (!tile || !tile.loaded) return null
    return tile.getHeightAt(worldX, worldZ)
  }

  // Get statistics
  public getStats(): {
    loadedTiles: number
    totalTiles: number
    pendingLoads: number
    pendingUnloads: number
    pendingBlends: number
    cacheStats: ReturnType<typeof MapTile.getCacheStats>
  } {
    return {
      loadedTiles: this.loadedCount,
      totalTiles: this.tiles.size,
      pendingLoads: this.pendingLoads.length,
      pendingUnloads: this.pendingUnloads.length,
      pendingBlends: this.pendingBlends.size,
      cacheStats: MapTile.getCacheStats(),
    }
  }

  // Set load/unload distances
  public setDistances(loadDistance: number, unloadDistance: number): void {
    this.config.loadDistance = loadDistance
    this.config.unloadDistance = Math.max(unloadDistance, loadDistance + 1)

    // Recalculate pending operations
    this.calculatePendingOperations(this.lastCameraTileX, this.lastCameraTileZ)
  }

  // Dispose all tiles and clear caches
  public dispose(): void {
    // Unload all tiles
    for (const tile of this.tiles.values()) {
      tile.dispose()
    }

    this.tiles.clear()
    this.loadedTiles.clear()
    this.pendingLoads = []
    this.pendingUnloads = []
    this.pendingBlends.clear()

    MapTile.clearCaches()

    this.loadedCount = 0
    this.totalGenerated = 0
  }
}
