import Random from '../map/random'

// Result of erosion containing all generated data maps
export interface ErosionResult {
  erosionMap: Float32Array // Amount eroded at each point
  depositMap: Float32Array // Amount deposited at each point
  flowMap: Float32Array // Water flow accumulation (how much water passed through)
}

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
  random = new Random(123)

  // Last erosion result
  private lastResult: ErosionResult | null = null

  /**
   * Get the result from the last erosion operation
   */
  getLastResult(): ErosionResult | null {
    return this.lastResult
  }

  erode(
    map: Float32Array,
    width: number,
    height: number,
    iterations: number = 50000
  ): ErosionResult {
    const size = width * height

    // Initialize tracking maps
    const erosionMap = new Float32Array(size)
    const depositMap = new Float32Array(size)
    const flowMap = new Float32Array(size)

    for (let i = 0; i < iterations; i++) {
      // Spawn New Droplet
      let posY = this.random.next() * (height - 1)
      let posX = this.random.next() * (width - 1)
      let dirX = 0
      let dirY = 0
      let speed = 1
      let water = 1
      let sediment = 0

      for (let step = 0; step < 30; step++) {
        const nodeX = Math.floor(posX)
        const nodeY = Math.floor(posY)
        const cellOffsetX = posX - nodeX
        const cellOffsetY = posY - nodeY

        // Track water flow at this position
        this.addToMap(
          flowMap,
          width,
          nodeX,
          nodeY,
          cellOffsetX,
          cellOffsetY,
          water
        )

        // Get height and gradient
        const heightData = this.calculateHeightAndGradient(
          map,
          width,
          height,
          posX,
          posY
        )

        // Calculate new direction
        dirX = dirX * this.inertia - heightData.gradientX * (1 - this.inertia)
        dirY = dirY * this.inertia - heightData.gradientY * (1 - this.inertia)

        // Normalize direction
        const len = Math.sqrt(dirX * dirX + dirY * dirY)
        if (len !== 0) {
          dirX /= len
          dirY /= len
        }

        posX += dirX
        posY += dirY

        // Stop if off map
        if (posX < 0 || posX >= width - 1 || posY < 0 || posY >= height - 1) {
          break
        }

        // Calculate new height
        const newHeightData = this.calculateHeightAndGradient(
          map,
          width,
          height,
          posX,
          posY
        )
        const diff = newHeightData.height - heightData.height

        // Sediment Capacity
        const sedimentCapacity = Math.max(
          -diff * speed * water * this.capacity,
          this.minSlope
        )

        if (sediment > sedimentCapacity || diff > 0) {
          // Deposit
          const amount =
            diff > 0
              ? Math.min(diff, sediment)
              : (sediment - sedimentCapacity) * this.deposition
          sediment -= amount

          // Add to height map
          this.deposit(
            map,
            width,
            height,
            nodeX,
            nodeY,
            cellOffsetX,
            cellOffsetY,
            amount
          )

          // Track deposit
          this.addToMap(
            depositMap,
            width,
            nodeX,
            nodeY,
            cellOffsetX,
            cellOffsetY,
            amount
          )
        } else {
          // Erode
          const amount = Math.min(
            (sedimentCapacity - sediment) * this.erosion,
            -diff
          )
          sediment += amount

          // Remove from height map
          this.deposit(
            map,
            width,
            height,
            nodeX,
            nodeY,
            cellOffsetX,
            cellOffsetY,
            -amount
          )

          // Track erosion
          this.addToMap(
            erosionMap,
            width,
            nodeX,
            nodeY,
            cellOffsetX,
            cellOffsetY,
            amount
          )
        }

        speed = Math.sqrt(Math.max(0, speed * speed - diff * this.gravity))
        water *= 1 - this.evaporation
      }
    }

    // Store result
    this.lastResult = { erosionMap, depositMap, flowMap }
    return this.lastResult
  }

  /**
   * Add value to a tracking map using bilinear distribution
   */
  private addToMap(
    targetMap: Float32Array,
    width: number,
    x: number,
    y: number,
    offsetX: number,
    offsetY: number,
    amount: number
  ): void {
    const idx = y * width + x
    targetMap[idx] += amount * (1 - offsetX) * (1 - offsetY)
    targetMap[idx + 1] += amount * offsetX * (1 - offsetY)
    targetMap[idx + width] += amount * (1 - offsetX) * offsetY
    targetMap[idx + width + 1] += amount * offsetX * offsetY
  }

  calculateHeightAndGradient(
    map: Float32Array,
    mapWidth: number,
    _mapHeight: number,
    posX: number,
    posY: number
  ) {
    const coordX = Math.floor(posX)
    const coordY = Math.floor(posY)
    const x = posX - coordX
    const y = posY - coordY

    const idx = coordY * mapWidth + coordX

    // Heights of the four corners
    const h00 = map[idx]
    const h10 = map[idx + 1]
    const h01 = map[idx + mapWidth]
    const h11 = map[idx + mapWidth + 1]

    // Bilinear interpolation for gradient
    const gradientX = (h10 - h00) * (1 - y) + (h11 - h01) * y
    const gradientY = (h01 - h00) * (1 - x) + (h11 - h10) * x

    // Bilinear interpolation for height
    const height =
      h00 * (1 - x) * (1 - y) +
      h10 * x * (1 - y) +
      h01 * (1 - x) * y +
      h11 * x * y

    return { height, gradientX, gradientY }
  }

  deposit(
    map: Float32Array,
    mapWidth: number,
    _mapHeight: number,
    x: number,
    y: number,
    offsetX: number,
    offsetY: number,
    amount: number
  ) {
    // Simple bilinear deposition
    const idx = y * mapWidth + x
    map[idx] += amount * (1 - offsetX) * (1 - offsetY)
    map[idx + 1] += amount * offsetX * (1 - offsetY)
    map[idx + mapWidth] += amount * (1 - offsetX) * offsetY
    map[idx + mapWidth + 1] += amount * offsetX * offsetY
  }
}
