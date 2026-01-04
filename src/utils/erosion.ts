/**
 * Optimized Hydraulic Erosion Simulation
 * Based on particle-based erosion with radius brushes
 */
export class Erosion {
  // Parameters
  inertia = 0.05
  minSlope = 0.01
  capacity = 4
  deposition = 0.1
  erosion = 0.1
  gravity = 4
  evaporation = 0.02
  radius = 3
  maxDropletLifetime = 30

  // Precomputed erosion brush data
  private brushIndices: Int32Array[] = []
  private brushWeights: Float32Array[] = []
  private currentRadius = -1
  private currentWidth = -1

  /**
   * Main erosion function - optimized for performance
   */
  erode(
    map: Float32Array,
    width: number,
    height: number,
    iterations: number = 50000
  ): void {
    // Precompute brush if needed
    if (this.currentRadius !== this.radius || this.currentWidth !== width) {
      this.precomputeBrushes(width, height)
    }

    // Cache parameters locally for faster access
    const inertia = this.inertia
    const minSlope = this.minSlope
    const capacityFactor = this.capacity
    const depositionRate = this.deposition
    const erosionRate = this.erosion
    const gravityFactor = this.gravity
    const evaporationRate = this.evaporation
    const maxLifetime = this.maxDropletLifetime
    const brushIndices = this.brushIndices
    const brushWeights = this.brushWeights

    // Bounds for droplet spawning (avoid edges)
    const spawnWidth = width - 2
    const spawnHeight = height - 2

    for (let iter = 0; iter < iterations; iter++) {
      // Spawn droplet at random position
      let posX = Math.random() * spawnWidth + 1
      let posY = Math.random() * spawnHeight + 1
      let dirX = 0
      let dirY = 0
      let speed = 1
      let water = 1
      let sediment = 0

      for (let lifetime = 0; lifetime < maxLifetime; lifetime++) {
        const nodeX = posX | 0 // Fast floor
        const nodeY = posY | 0
        const dropletIndex = nodeY * width + nodeX

        // Cell offset for bilinear interpolation
        const cellOffsetX = posX - nodeX
        const cellOffsetY = posY - nodeY

        // Calculate height and gradient (inlined for performance)
        const idx = dropletIndex
        const h00 = map[idx]
        const h10 = map[idx + 1]
        const h01 = map[idx + width]
        const h11 = map[idx + width + 1]

        // Bilinear interpolation
        const oneMinusX = 1 - cellOffsetX
        const oneMinusY = 1 - cellOffsetY

        const currentHeight =
          h00 * oneMinusX * oneMinusY +
          h10 * cellOffsetX * oneMinusY +
          h01 * oneMinusX * cellOffsetY +
          h11 * cellOffsetX * cellOffsetY

        // Gradient calculation
        const gradientX = (h10 - h00) * oneMinusY + (h11 - h01) * cellOffsetY
        const gradientY = (h01 - h00) * oneMinusX + (h11 - h10) * cellOffsetX

        // Update direction with inertia
        dirX = dirX * inertia - gradientX * (1 - inertia)
        dirY = dirY * inertia - gradientY * (1 - inertia)

        // Normalize direction (with fast inverse sqrt approximation)
        const lenSq = dirX * dirX + dirY * dirY
        if (lenSq > 0.0001) {
          const invLen = 1 / Math.sqrt(lenSq)
          dirX *= invLen
          dirY *= invLen
        } else {
          // Random direction if stuck
          const angle = Math.random() * 6.283185307
          dirX = Math.cos(angle)
          dirY = Math.sin(angle)
        }

        // Move droplet
        posX += dirX
        posY += dirY

        // Check bounds
        if (posX < 1 || posX >= width - 2 || posY < 1 || posY >= height - 2) {
          break
        }

        // Calculate new height (inlined)
        const newNodeX = posX | 0
        const newNodeY = posY | 0
        const newIdx = newNodeY * width + newNodeX
        const newOffsetX = posX - newNodeX
        const newOffsetY = posY - newNodeY
        const newOneMinusX = 1 - newOffsetX
        const newOneMinusY = 1 - newOffsetY

        const newHeight =
          map[newIdx] * newOneMinusX * newOneMinusY +
          map[newIdx + 1] * newOffsetX * newOneMinusY +
          map[newIdx + width] * newOneMinusX * newOffsetY +
          map[newIdx + width + 1] * newOffsetX * newOffsetY

        const heightDiff = newHeight - currentHeight

        // Calculate sediment capacity
        const sedimentCapacity =
          Math.max(-heightDiff, minSlope) * speed * water * capacityFactor

        if (sediment > sedimentCapacity || heightDiff > 0) {
          // Deposit sediment
          const depositAmount =
            heightDiff > 0
              ? Math.min(heightDiff, sediment)
              : (sediment - sedimentCapacity) * depositionRate

          sediment -= depositAmount

          // Bilinear deposit (inlined)
          map[idx] += depositAmount * oneMinusX * oneMinusY
          map[idx + 1] += depositAmount * cellOffsetX * oneMinusY
          map[idx + width] += depositAmount * oneMinusX * cellOffsetY
          map[idx + width + 1] += depositAmount * cellOffsetX * cellOffsetY
        } else {
          // Erode terrain using brush
          const erodeAmount = Math.min(
            (sedimentCapacity - sediment) * erosionRate,
            -heightDiff
          )

          // Use precomputed brush for smooth erosion
          const indices = brushIndices[dropletIndex]
          const weights = brushWeights[dropletIndex]

          if (indices && weights) {
            const numBrushPoints = indices.length
            for (let i = 0; i < numBrushPoints; i++) {
              const brushIdx = indices[i]
              const weighedErodeAmount = erodeAmount * weights[i]
              const deltaSediment =
                map[brushIdx] < weighedErodeAmount
                  ? map[brushIdx]
                  : weighedErodeAmount
              map[brushIdx] -= deltaSediment
              sediment += deltaSediment
            }
          } else {
            // Fallback to simple erosion if brush not available
            sediment += erodeAmount
            map[idx] -= erodeAmount * oneMinusX * oneMinusY
            map[idx + 1] -= erodeAmount * cellOffsetX * oneMinusY
            map[idx + width] -= erodeAmount * oneMinusX * cellOffsetY
            map[idx + width + 1] -= erodeAmount * cellOffsetX * cellOffsetY
          }
        }

        // Update speed and water
        speed = Math.sqrt(Math.max(0, speed * speed + heightDiff * gravityFactor))
        water *= 1 - evaporationRate
      }
    }
  }

  /**
   * Precompute erosion brushes for each map position
   * This creates a circular brush with smooth falloff
   */
  private precomputeBrushes(width: number, height: number): void {
    this.currentRadius = this.radius
    this.currentWidth = width

    const radius = this.radius
    const radiusSq = radius * radius
    const mapSize = width * height

    this.brushIndices = new Array(mapSize)
    this.brushWeights = new Array(mapSize)

    // Precompute weight sum for normalization
    const weightTemplate: number[] = []
    const offsetTemplate: [number, number][] = []

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distSq = dx * dx + dy * dy
        if (distSq <= radiusSq) {
          const dist = Math.sqrt(distSq)
          const weight = Math.max(0, radius - dist)
          if (weight > 0) {
            offsetTemplate.push([dx, dy])
            weightTemplate.push(weight)
          }
        }
      }
    }

    // Normalize weights
    const weightSum = weightTemplate.reduce((a, b) => a + b, 0)
    const normalizedWeights = weightTemplate.map((w) => w / weightSum)

    // Create brushes for each valid position
    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        const centerIdx = y * width + x
        const indices: number[] = []
        const weights: number[] = []

        for (let i = 0; i < offsetTemplate.length; i++) {
          const [dx, dy] = offsetTemplate[i]
          const brushIdx = (y + dy) * width + (x + dx)
          indices.push(brushIdx)
          weights.push(normalizedWeights[i])
        }

        this.brushIndices[centerIdx] = new Int32Array(indices)
        this.brushWeights[centerIdx] = new Float32Array(weights)
      }
    }
  }

  /**
   * Fast erosion without radius brush (for very large maps)
   */
  erodeFast(
    map: Float32Array,
    width: number,
    height: number,
    iterations: number = 50000
  ): void {
    const inertia = this.inertia
    const minSlope = this.minSlope
    const capacityFactor = this.capacity
    const depositionRate = this.deposition
    const erosionRate = this.erosion
    const gravityFactor = this.gravity
    const evaporationRate = this.evaporation
    const maxLifetime = this.maxDropletLifetime

    const spawnWidth = width - 2
    const spawnHeight = height - 2

    for (let iter = 0; iter < iterations; iter++) {
      let posX = Math.random() * spawnWidth + 1
      let posY = Math.random() * spawnHeight + 1
      let dirX = 0
      let dirY = 0
      let speed = 1
      let water = 1
      let sediment = 0

      for (let lifetime = 0; lifetime < maxLifetime; lifetime++) {
        const nodeX = posX | 0
        const nodeY = posY | 0
        const idx = nodeY * width + nodeX

        const cellOffsetX = posX - nodeX
        const cellOffsetY = posY - nodeY
        const oneMinusX = 1 - cellOffsetX
        const oneMinusY = 1 - cellOffsetY

        // Get heights
        const h00 = map[idx]
        const h10 = map[idx + 1]
        const h01 = map[idx + width]
        const h11 = map[idx + width + 1]

        // Current height
        const currentHeight =
          h00 * oneMinusX * oneMinusY +
          h10 * cellOffsetX * oneMinusY +
          h01 * oneMinusX * cellOffsetY +
          h11 * cellOffsetX * cellOffsetY

        // Gradient
        const gradientX = (h10 - h00) * oneMinusY + (h11 - h01) * cellOffsetY
        const gradientY = (h01 - h00) * oneMinusX + (h11 - h10) * cellOffsetX

        // Update direction
        dirX = dirX * inertia - gradientX * (1 - inertia)
        dirY = dirY * inertia - gradientY * (1 - inertia)

        // Normalize
        const lenSq = dirX * dirX + dirY * dirY
        if (lenSq > 0.0001) {
          const invLen = 1 / Math.sqrt(lenSq)
          dirX *= invLen
          dirY *= invLen
        }

        posX += dirX
        posY += dirY

        if (posX < 1 || posX >= width - 2 || posY < 1 || posY >= height - 2) {
          break
        }

        // New height
        const newNodeX = posX | 0
        const newNodeY = posY | 0
        const newIdx = newNodeY * width + newNodeX
        const newOffsetX = posX - newNodeX
        const newOffsetY = posY - newNodeY

        const newHeight =
          map[newIdx] * (1 - newOffsetX) * (1 - newOffsetY) +
          map[newIdx + 1] * newOffsetX * (1 - newOffsetY) +
          map[newIdx + width] * (1 - newOffsetX) * newOffsetY +
          map[newIdx + width + 1] * newOffsetX * newOffsetY

        const heightDiff = newHeight - currentHeight
        const sedimentCapacity =
          Math.max(-heightDiff, minSlope) * speed * water * capacityFactor

        if (sediment > sedimentCapacity || heightDiff > 0) {
          const depositAmount =
            heightDiff > 0
              ? Math.min(heightDiff, sediment)
              : (sediment - sedimentCapacity) * depositionRate

          sediment -= depositAmount
          map[idx] += depositAmount * oneMinusX * oneMinusY
          map[idx + 1] += depositAmount * cellOffsetX * oneMinusY
          map[idx + width] += depositAmount * oneMinusX * cellOffsetY
          map[idx + width + 1] += depositAmount * cellOffsetX * cellOffsetY
        } else {
          const erodeAmount = Math.min(
            (sedimentCapacity - sediment) * erosionRate,
            -heightDiff
          )
          sediment += erodeAmount
          map[idx] -= erodeAmount * oneMinusX * oneMinusY
          map[idx + 1] -= erodeAmount * cellOffsetX * oneMinusY
          map[idx + width] -= erodeAmount * oneMinusX * cellOffsetY
          map[idx + width + 1] -= erodeAmount * cellOffsetX * cellOffsetY
        }

        speed = Math.sqrt(Math.max(0, speed * speed + heightDiff * gravityFactor))
        water *= 1 - evaporationRate
      }
    }
  }

  /**
   * Reset precomputed brushes (call when changing radius)
   */
  resetBrushes(): void {
    this.brushIndices = []
    this.brushWeights = []
    this.currentRadius = -1
    this.currentWidth = -1
  }
}
