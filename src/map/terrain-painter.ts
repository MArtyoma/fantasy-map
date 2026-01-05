import * as THREE from 'three'
import type { ErosionResult } from '../utils/erosion'

/**
 * Color rule for terrain painting based on various factors
 */
export interface ColorRule {
  color: THREE.Color | number | string
  // Height-based conditions (normalized 0-1 within tile)
  minHeight?: number
  maxHeight?: number
  // Slope-based conditions (0 = flat, 1 = vertical)
  minSlope?: number
  maxSlope?: number
  // Erosion-based conditions (normalized values)
  minErosion?: number
  maxErosion?: number
  // Deposit-based conditions (normalized values)
  minDeposit?: number
  maxDeposit?: number
  // Water flow conditions (normalized values)
  minFlow?: number
  maxFlow?: number
  // Blending settings
  blendWeight?: number // Weight for this rule (default 1)
  blendMode?: 'mix' | 'add' | 'multiply' // How to blend with other colors
}

/**
 * Configuration for terrain painter
 */
export interface TerrainPainterConfig {
  // Base color when no rules match
  baseColor: THREE.Color | number | string
  // Color rules (applied in order, later rules can override earlier)
  rules: ColorRule[]
  // Global settings
  heightInfluence: number // 0-1, how much height affects color
  slopeInfluence: number // 0-1, how much slope affects color
  erosionInfluence: number // 0-1, how much erosion affects color
  depositInfluence: number // 0-1, how much deposit affects color
  flowInfluence: number // 0-1, how much flow affects color
  // Normalization
  erosionNormalization: number // Value to normalize erosion (max expected erosion)
  depositNormalization: number // Value to normalize deposit
  flowNormalization: number // Value to normalize flow
  // Smoothing
  blendSharpness: number // 0-1, how sharp the transitions are (1 = sharp, 0 = smooth)
}

/**
 * Default terrain painter configuration
 */
export const DEFAULT_TERRAIN_PAINTER_CONFIG: TerrainPainterConfig = {
  baseColor: 0x4a7c4e, // Green grass
  rules: [
    // Deep valleys (low height + high flow)
    {
      color: 0x3a5a3e, // Dark green
      maxHeight: 0.3,
      minFlow: 0.3,
      blendWeight: 0.8,
    },
    // Rocky slopes
    {
      color: 0x808080, // Gray rock
      minSlope: 0.5,
      blendWeight: 1.0,
    },
    // Eroded areas (brownish)
    {
      color: 0x8b7355, // Brown dirt
      minErosion: 0.2,
      blendWeight: 0.7,
    },
    // Deposit areas (lighter)
    {
      color: 0x9acd32, // Yellow-green
      minDeposit: 0.3,
      blendWeight: 0.5,
    },
    // High peaks (snow/rock)
    {
      color: 0xd3d3d3, // Light gray
      minHeight: 0.8,
      blendWeight: 0.9,
    },
    // Steep cliffs
    {
      color: 0x696969, // Dark gray
      minSlope: 0.7,
      blendWeight: 1.0,
    },
  ],
  heightInfluence: 0.3,
  slopeInfluence: 0.5,
  erosionInfluence: 0.6,
  depositInfluence: 0.4,
  flowInfluence: 0.3,
  erosionNormalization: 1.0,
  depositNormalization: 1.0,
  flowNormalization: 100.0,
  blendSharpness: 0.5,
}

/**
 * Terrain data for a single vertex
 */
interface VertexData {
  height: number // Normalized height (0-1)
  slope: number // Slope value (0-1, 0 = flat, 1 = vertical)
  erosion: number // Normalized erosion amount
  deposit: number // Normalized deposit amount
  flow: number // Normalized water flow
}

/**
 * TerrainPainter - Controls vertex coloring for MapTile based on terrain properties
 */
export class TerrainPainter {
  private config: TerrainPainterConfig
  private baseColor: THREE.Color

  constructor(config: Partial<TerrainPainterConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN_PAINTER_CONFIG, ...config }
    this.baseColor = new THREE.Color(this.config.baseColor)
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<TerrainPainterConfig>): void {
    this.config = { ...this.config, ...config }
    this.baseColor = new THREE.Color(this.config.baseColor)
  }

  /**
   * Get current configuration
   */
  getConfig(): TerrainPainterConfig {
    return { ...this.config }
  }

  /**
   * Calculate vertex colors for a tile
   * @param heightMap - The height map data
   * @param normals - Normal vectors for each vertex
   * @param erosionResult - Result from erosion simulation (optional)
   * @param segments - Number of segments in the tile
   * @param heightScale - Scale factor for heights
   * @returns Float32Array of RGB colors for each vertex
   */
  calculateVertexColors(
    heightMap: Float32Array,
    normals: Float32Array | null,
    erosionResult: ErosionResult | null,
    segments: number,
    heightScale: number
  ): Float32Array {
    const vertexCount = (segments + 1) * (segments + 1)
    const colors = new Float32Array(vertexCount * 3)

    // Find height range for normalization
    let minHeight = Infinity
    let maxHeight = -Infinity
    for (let i = 0; i < heightMap.length; i++) {
      if (heightMap[i] < minHeight) minHeight = heightMap[i]
      if (heightMap[i] > maxHeight) maxHeight = heightMap[i]
    }
    const heightRange = maxHeight - minHeight || 1

    // Find max values for erosion data normalization
    let maxErosion = this.config.erosionNormalization
    let maxDeposit = this.config.depositNormalization
    let maxFlow = this.config.flowNormalization

    if (erosionResult) {
      // Optionally auto-calculate normalization from data
      for (let i = 0; i < erosionResult.erosionMap.length; i++) {
        if (erosionResult.erosionMap[i] > maxErosion)
          maxErosion = erosionResult.erosionMap[i]
        if (erosionResult.depositMap[i] > maxDeposit)
          maxDeposit = erosionResult.depositMap[i]
        if (erosionResult.flowMap[i] > maxFlow)
          maxFlow = erosionResult.flowMap[i]
      }
    }

    // Calculate color for each vertex
    const vertexCountPerSide = segments + 1

    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j <= segments; j++) {
        const vertexIndex = i * vertexCountPerSide + j
        const colorIndex = vertexIndex * 3

        // Gather vertex data
        const vertexData = this.gatherVertexData(
          heightMap,
          normals,
          erosionResult,
          vertexIndex,
          vertexCountPerSide,
          minHeight,
          heightRange,
          heightScale,
          maxErosion,
          maxDeposit,
          maxFlow
        )

        // Calculate final color
        const color = this.calculateColor(vertexData)

        colors[colorIndex] = color.r
        colors[colorIndex + 1] = color.g
        colors[colorIndex + 2] = color.b
      }
    }

    return colors
  }

  /**
   * Gather all relevant data for a vertex
   */
  private gatherVertexData(
    heightMap: Float32Array,
    normals: Float32Array | null,
    erosionResult: ErosionResult | null,
    index: number,
    _vertexCountPerSide: number,
    minHeight: number,
    heightRange: number,
    _heightScale: number,
    maxErosion: number,
    maxDeposit: number,
    maxFlow: number
  ): VertexData {
    // Height (normalized 0-1)
    const height = (heightMap[index] - minHeight) / heightRange

    // Slope from normal (0 = flat, 1 = vertical)
    let slope = 0
    if (normals) {
      const ny = normals[index * 3 + 1] // Y component of normal
      slope = 1 - Math.abs(ny) // 0 when pointing up, 1 when horizontal
    }

    // Erosion data
    let erosion = 0
    let deposit = 0
    let flow = 0

    if (erosionResult) {
      erosion = Math.min(1, erosionResult.erosionMap[index] / maxErosion)
      deposit = Math.min(1, erosionResult.depositMap[index] / maxDeposit)
      flow = Math.min(1, erosionResult.flowMap[index] / maxFlow)
    }

    return { height, slope, erosion, deposit, flow }
  }

  /**
   * Calculate the final color for a vertex based on its data
   */
  private calculateColor(data: VertexData): THREE.Color {
    const resultColor = this.baseColor.clone()
    let totalWeight = 0

    for (const rule of this.config.rules) {
      const ruleMatch = this.evaluateRule(rule, data)

      if (ruleMatch > 0) {
        const ruleColor = new THREE.Color(rule.color)
        const weight = (rule.blendWeight ?? 1) * ruleMatch

        // Apply influence settings
        const finalWeight = weight * this.calculateInfluenceWeight(rule, data)

        if (finalWeight > 0) {
          const blendMode = rule.blendMode ?? 'mix'

          switch (blendMode) {
            case 'mix':
              resultColor.lerp(ruleColor, finalWeight / (totalWeight + 1))
              break
            case 'add':
              resultColor.add(
                ruleColor.clone().multiplyScalar(finalWeight * 0.5)
              )
              break
            case 'multiply':
              const blendColor = ruleColor
                .clone()
                .lerp(new THREE.Color(1, 1, 1), 1 - finalWeight)
              resultColor.multiply(blendColor)
              break
          }

          totalWeight += finalWeight
        }
      }
    }

    // Clamp result
    resultColor.r = Math.min(1, Math.max(0, resultColor.r))
    resultColor.g = Math.min(1, Math.max(0, resultColor.g))
    resultColor.b = Math.min(1, Math.max(0, resultColor.b))

    return resultColor
  }

  /**
   * Evaluate how well a rule matches the vertex data (0-1)
   */
  private evaluateRule(rule: ColorRule, data: VertexData): number {
    const { blendSharpness } = this.config
    let match = 1

    // Height check
    if (rule.minHeight !== undefined || rule.maxHeight !== undefined) {
      const heightMatch = this.evaluateRange(
        data.height,
        rule.minHeight ?? 0,
        rule.maxHeight ?? 1,
        blendSharpness
      )
      match *= heightMatch
    }

    // Slope check
    if (rule.minSlope !== undefined || rule.maxSlope !== undefined) {
      const slopeMatch = this.evaluateRange(
        data.slope,
        rule.minSlope ?? 0,
        rule.maxSlope ?? 1,
        blendSharpness
      )
      match *= slopeMatch
    }

    // Erosion check
    if (rule.minErosion !== undefined || rule.maxErosion !== undefined) {
      const erosionMatch = this.evaluateRange(
        data.erosion,
        rule.minErosion ?? 0,
        rule.maxErosion ?? 1,
        blendSharpness
      )
      match *= erosionMatch
    }

    // Deposit check
    if (rule.minDeposit !== undefined || rule.maxDeposit !== undefined) {
      const depositMatch = this.evaluateRange(
        data.deposit,
        rule.minDeposit ?? 0,
        rule.maxDeposit ?? 1,
        blendSharpness
      )
      match *= depositMatch
    }

    // Flow check
    if (rule.minFlow !== undefined || rule.maxFlow !== undefined) {
      const flowMatch = this.evaluateRange(
        data.flow,
        rule.minFlow ?? 0,
        rule.maxFlow ?? 1,
        blendSharpness
      )
      match *= flowMatch
    }

    return match
  }

  /**
   * Evaluate if a value is within a range with smooth falloff
   */
  private evaluateRange(
    value: number,
    min: number,
    max: number,
    sharpness: number
  ): number {
    if (value < min) {
      const edge = min * (1 - (1 - sharpness) * 0.3)
      if (value < edge) return 0
      return this.smoothstep(edge, min, value)
    }
    if (value > max) {
      const edge = max + (1 - max) * (1 - sharpness) * 0.3
      if (value > edge) return 0
      return 1 - this.smoothstep(max, edge, value)
    }
    return 1
  }

  /**
   * Calculate influence weight based on config
   */
  private calculateInfluenceWeight(rule: ColorRule, data: VertexData): number {
    let weight = 1

    // Apply influence based on what conditions the rule uses
    if (rule.minHeight !== undefined || rule.maxHeight !== undefined) {
      weight *= this.config.heightInfluence + (1 - this.config.heightInfluence) * 0.5
    }
    if (rule.minSlope !== undefined || rule.maxSlope !== undefined) {
      weight *= this.config.slopeInfluence + (1 - this.config.slopeInfluence) * 0.5
    }
    if (rule.minErosion !== undefined || rule.maxErosion !== undefined) {
      weight *= this.config.erosionInfluence + (1 - this.config.erosionInfluence) * 0.5
    }
    if (rule.minDeposit !== undefined || rule.maxDeposit !== undefined) {
      weight *= this.config.depositInfluence + (1 - this.config.depositInfluence) * 0.5
    }
    if (rule.minFlow !== undefined || rule.maxFlow !== undefined) {
      weight *= this.config.flowInfluence + (1 - this.config.flowInfluence) * data.flow
    }

    return weight
  }

  /**
   * Smoothstep interpolation
   */
  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }

  /**
   * Apply vertex colors to a geometry
   */
  applyToGeometry(
    geometry: THREE.BufferGeometry,
    colors: Float32Array
  ): void {
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }

  /**
   * Create a material that supports vertex colors
   */
  static createVertexColorMaterial(
    options: Partial<THREE.MeshStandardMaterialParameters> = {}
  ): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: false,
      ...options,
    })
  }
}

export default TerrainPainter
