import * as THREE from 'three'

/**
 * Configuration for cartoon outline effect
 */
export interface CartoonOutlineConfig {
  /** Enable/disable outline rendering */
  enabled: boolean
  /** Outline color (default: black) */
  color: THREE.Color | number | string
  /** Outline thickness in world units */
  thickness: number
  /** Bias for outline - pushes outline along normals (helps with steep angles) */
  bias: number
  /** Alpha/opacity of the outline (0-1) */
  opacity: number
}

/**
 * Configuration for cartoon shading
 */
export interface CartoonShadingConfig {
  /** Number of discrete shading levels (2-10 recommended) */
  levels: number
  /** Ambient light contribution (0-1) */
  ambientStrength: number
  /** Diffuse light contribution (0-1) */
  diffuseStrength: number
  /** Edge softness between shading levels (0 = hard, 1 = soft) */
  edgeSoftness: number
  /** Saturation boost for cartoon effect (1 = normal, >1 = more saturated) */
  saturationBoost: number
  /** Brightness adjustment (-1 to 1) */
  brightnessAdjust: number
}

/**
 * Full cartoon material configuration
 */
export interface CartoonConfig {
  /** Enable cartoon shading (if false, uses standard shading) */
  enabled: boolean
  /** Outline configuration */
  outline: CartoonOutlineConfig
  /** Shading configuration */
  shading: CartoonShadingConfig
}

/**
 * Default outline configuration
 */
export const DEFAULT_OUTLINE_CONFIG: CartoonOutlineConfig = {
  enabled: true,
  color: 0x000000,
  thickness: 0.05,
  bias: 0.0,
  opacity: 1.0,
}

/**
 * Default shading configuration
 */
export const DEFAULT_SHADING_CONFIG: CartoonShadingConfig = {
  levels: 4,
  ambientStrength: 0.3,
  diffuseStrength: 0.7,
  edgeSoftness: 0.1,
  saturationBoost: 1.2,
  brightnessAdjust: 0.0,
}

/**
 * Default cartoon configuration
 */
export const DEFAULT_CARTOON_CONFIG: CartoonConfig = {
  enabled: false,
  outline: DEFAULT_OUTLINE_CONFIG,
  shading: DEFAULT_SHADING_CONFIG,
}

/**
 * Vertex shader for cartoon material with vertex colors
 */
const cartoonVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  varying vec3 vColor;

  void main() {
    // Pass vertex color to fragment shader
    vColor = color;
    
    // Transform normal to view space
    vNormal = normalize(normalMatrix * normal);
    
    // Calculate view-space position
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    
    // World position for lighting calculations
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    
    gl_Position = projectionMatrix * mvPosition;
  }
`

/**
 * Fragment shader for cartoon material with cel shading
 */
const cartoonFragmentShader = /* glsl */ `
  uniform vec3 lightDirection;
  uniform float levels;
  uniform float ambientStrength;
  uniform float diffuseStrength;
  uniform float edgeSoftness;
  uniform float saturationBoost;
  uniform float brightnessAdjust;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  varying vec3 vColor;

  // Convert RGB to HSL
  vec3 rgbToHsl(vec3 c) {
    float maxC = max(max(c.r, c.g), c.b);
    float minC = min(min(c.r, c.g), c.b);
    float l = (maxC + minC) / 2.0;
    
    if (maxC == minC) {
      return vec3(0.0, 0.0, l);
    }
    
    float d = maxC - minC;
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    
    float h;
    if (maxC == c.r) {
      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    } else if (maxC == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;
    
    return vec3(h, s, l);
  }

  // Convert HSL to RGB
  float hueToRgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0/2.0) return q;
    if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
    return p;
  }

  vec3 hslToRgb(vec3 c) {
    if (c.y == 0.0) {
      return vec3(c.z);
    }
    
    float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
    float p = 2.0 * c.z - q;
    
    return vec3(
      hueToRgb(p, q, c.x + 1.0/3.0),
      hueToRgb(p, q, c.x),
      hueToRgb(p, q, c.x - 1.0/3.0)
    );
  }

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 lightDir = normalize(lightDirection);
    
    // Calculate diffuse lighting with cel shading
    float NdotL = dot(normal, lightDir);
    float diffuse = max(0.0, NdotL);
    
    // Quantize lighting into discrete levels (cel shading)
    float levelSize = 1.0 / levels;
    float quantized = floor(diffuse / levelSize) * levelSize;
    
    // Add edge softness for smoother transitions
    float nextLevel = quantized + levelSize;
    float t = (diffuse - quantized) / levelSize;
    float smoothT = smoothstep(1.0 - edgeSoftness, 1.0, t);
    float finalDiffuse = mix(quantized, min(nextLevel, 1.0), smoothT);
    
    // Combine ambient and diffuse
    float lighting = ambientStrength + diffuseStrength * finalDiffuse;
    lighting = clamp(lighting, 0.0, 1.0);
    
    // Apply lighting to vertex color
    vec3 litColor = vColor * lighting;
    
    // Apply saturation boost
    vec3 hsl = rgbToHsl(litColor);
    hsl.y = min(1.0, hsl.y * saturationBoost);
    
    // Apply brightness adjustment
    hsl.z = clamp(hsl.z + brightnessAdjust, 0.0, 1.0);
    
    vec3 finalColor = hslToRgb(hsl);
    
    gl_FragColor = vec4(finalColor, 1.0);
  }
`

/**
 * Vertex shader for outline effect
 * Renders the mesh slightly larger along normals
 */
const outlineVertexShader = /* glsl */ `
  uniform float outlineThickness;
  uniform float outlineBias;

  void main() {
    // Expand vertices along their normals
    vec3 expandedPosition = position + normal * outlineThickness;
    
    // Apply bias (helps with artifacts on steep angles)
    vec4 mvPosition = modelViewMatrix * vec4(expandedPosition, 1.0);
    mvPosition.z += outlineBias;
    
    gl_Position = projectionMatrix * mvPosition;
  }
`

/**
 * Fragment shader for outline effect
 * Simply renders a solid color
 */
const outlineFragmentShader = /* glsl */ `
  uniform vec3 outlineColor;
  uniform float outlineOpacity;

  void main() {
    gl_FragColor = vec4(outlineColor, outlineOpacity);
  }
`

/**
 * Creates a cartoon ShaderMaterial with cel shading and vertex colors
 */
export function createCartoonMaterial(
  config: Partial<CartoonShadingConfig> = {}
): THREE.ShaderMaterial {
  const shadingConfig = { ...DEFAULT_SHADING_CONFIG, ...config }

  return new THREE.ShaderMaterial({
    vertexShader: cartoonVertexShader,
    fragmentShader: cartoonFragmentShader,
    uniforms: {
      lightDirection: { value: new THREE.Vector3(1, 1, 1).normalize() },
      levels: { value: shadingConfig.levels },
      ambientStrength: { value: shadingConfig.ambientStrength },
      diffuseStrength: { value: shadingConfig.diffuseStrength },
      edgeSoftness: { value: shadingConfig.edgeSoftness },
      saturationBoost: { value: shadingConfig.saturationBoost },
      brightnessAdjust: { value: shadingConfig.brightnessAdjust },
    },
    vertexColors: true,
    side: THREE.FrontSide,
  })
}

/**
 * Creates an outline material for the cartoon effect
 */
export function createOutlineMaterial(
  config: Partial<CartoonOutlineConfig> = {}
): THREE.ShaderMaterial {
  const outlineConfig = { ...DEFAULT_OUTLINE_CONFIG, ...config }
  const outlineColor = new THREE.Color(outlineConfig.color)

  return new THREE.ShaderMaterial({
    vertexShader: outlineVertexShader,
    fragmentShader: outlineFragmentShader,
    uniforms: {
      outlineThickness: { value: outlineConfig.thickness },
      outlineBias: { value: outlineConfig.bias },
      outlineColor: { value: outlineColor },
      outlineOpacity: { value: outlineConfig.opacity },
    },
    side: THREE.BackSide, // Render back faces for outline effect
    transparent: outlineConfig.opacity < 1.0,
    depthWrite: true,
  })
}

/**
 * Updates cartoon material uniforms
 */
export function updateCartoonMaterial(
  material: THREE.ShaderMaterial,
  config: Partial<CartoonShadingConfig>
): void {
  if (config.levels !== undefined) {
    material.uniforms.levels.value = config.levels
  }
  if (config.ambientStrength !== undefined) {
    material.uniforms.ambientStrength.value = config.ambientStrength
  }
  if (config.diffuseStrength !== undefined) {
    material.uniforms.diffuseStrength.value = config.diffuseStrength
  }
  if (config.edgeSoftness !== undefined) {
    material.uniforms.edgeSoftness.value = config.edgeSoftness
  }
  if (config.saturationBoost !== undefined) {
    material.uniforms.saturationBoost.value = config.saturationBoost
  }
  if (config.brightnessAdjust !== undefined) {
    material.uniforms.brightnessAdjust.value = config.brightnessAdjust
  }
}

/**
 * Updates outline material uniforms
 */
export function updateOutlineMaterial(
  material: THREE.ShaderMaterial,
  config: Partial<CartoonOutlineConfig>
): void {
  if (config.thickness !== undefined) {
    material.uniforms.outlineThickness.value = config.thickness
  }
  if (config.bias !== undefined) {
    material.uniforms.outlineBias.value = config.bias
  }
  if (config.color !== undefined) {
    material.uniforms.outlineColor.value = new THREE.Color(config.color)
  }
  if (config.opacity !== undefined) {
    material.uniforms.outlineOpacity.value = config.opacity
    material.transparent = config.opacity < 1.0
  }
}

/**
 * Sets the light direction for the cartoon material
 */
export function setCartoonLightDirection(
  material: THREE.ShaderMaterial,
  direction: THREE.Vector3
): void {
  material.uniforms.lightDirection.value = direction.clone().normalize()
}

/**
 * CartoonMeshGroup - A group containing both the main mesh and outline mesh
 * This provides an easy way to manage cartoon-styled objects
 */
export class CartoonMeshGroup extends THREE.Group {
  public mainMesh: THREE.Mesh
  public outlineMesh: THREE.Mesh | null = null
  private cartoonMaterial: THREE.ShaderMaterial
  private outlineMaterial: THREE.ShaderMaterial | null = null
  private config: CartoonConfig

  constructor(
    geometry: THREE.BufferGeometry,
    config: Partial<CartoonConfig> = {}
  ) {
    super()

    this.config = {
      enabled: config.enabled ?? DEFAULT_CARTOON_CONFIG.enabled,
      outline: { ...DEFAULT_OUTLINE_CONFIG, ...config.outline },
      shading: { ...DEFAULT_SHADING_CONFIG, ...config.shading },
    }

    // Create main cartoon material
    this.cartoonMaterial = createCartoonMaterial(this.config.shading)

    // Create main mesh
    this.mainMesh = new THREE.Mesh(geometry, this.cartoonMaterial)
    this.add(this.mainMesh)

    // Create outline if enabled
    if (this.config.outline.enabled) {
      this.createOutlineMesh(geometry)
    }
  }

  private createOutlineMesh(geometry: THREE.BufferGeometry): void {
    this.outlineMaterial = createOutlineMaterial(this.config.outline)
    this.outlineMesh = new THREE.Mesh(geometry, this.outlineMaterial)
    this.outlineMesh.renderOrder = -1 // Render outline before main mesh
    this.add(this.outlineMesh)
  }

  /**
   * Update geometry for both main and outline meshes
   */
  public setGeometry(geometry: THREE.BufferGeometry): void {
    this.mainMesh.geometry = geometry
    if (this.outlineMesh) {
      this.outlineMesh.geometry = geometry
    }
  }

  /**
   * Update outline configuration
   */
  public setOutlineConfig(config: Partial<CartoonOutlineConfig>): void {
    this.config.outline = { ...this.config.outline, ...config }

    if (config.enabled !== undefined) {
      if (config.enabled && !this.outlineMesh) {
        this.createOutlineMesh(this.mainMesh.geometry)
      } else if (!config.enabled && this.outlineMesh) {
        this.remove(this.outlineMesh)
        this.outlineMaterial?.dispose()
        this.outlineMesh = null
        this.outlineMaterial = null
      }
    }

    if (this.outlineMaterial) {
      updateOutlineMaterial(this.outlineMaterial, config)
    }
  }

  /**
   * Update shading configuration
   */
  public setShadingConfig(config: Partial<CartoonShadingConfig>): void {
    this.config.shading = { ...this.config.shading, ...config }
    updateCartoonMaterial(this.cartoonMaterial, config)
  }

  /**
   * Set light direction
   */
  public setLightDirection(direction: THREE.Vector3): void {
    setCartoonLightDirection(this.cartoonMaterial, direction)
  }

  /**
   * Get current configuration
   */
  public getConfig(): CartoonConfig {
    return { ...this.config }
  }

  /**
   * Get the main cartoon material
   */
  public getCartoonMaterial(): THREE.ShaderMaterial {
    return this.cartoonMaterial
  }

  /**
   * Get the outline material (may be null if outline is disabled)
   */
  public getOutlineMaterial(): THREE.ShaderMaterial | null {
    return this.outlineMaterial
  }

  /**
   * Enable/disable shadows
   */
  public setShadows(cast: boolean, receive: boolean): void {
    this.mainMesh.castShadow = cast
    this.mainMesh.receiveShadow = receive
    if (this.outlineMesh) {
      this.outlineMesh.castShadow = false
      this.outlineMesh.receiveShadow = false
    }
  }

  /**
   * Dispose of all resources
   */
  public dispose(): void {
    this.cartoonMaterial.dispose()
    this.outlineMaterial?.dispose()
  }
}

export default {
  createCartoonMaterial,
  createOutlineMaterial,
  updateCartoonMaterial,
  updateOutlineMaterial,
  setCartoonLightDirection,
  CartoonMeshGroup,
  DEFAULT_CARTOON_CONFIG,
  DEFAULT_OUTLINE_CONFIG,
  DEFAULT_SHADING_CONFIG,
}
