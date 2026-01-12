import { deserializeFloat32Array } from '../utils'
import { DEFAULT_CARTOON_CONFIG } from './CartoonMaterial'
import { TileManager } from './TileManager'
import { CameraController } from './camera-controller'
import { DEFAULT_TERRAIN_PAINTER_CONFIG } from './terrain-painter'
import * as THREE from 'three'

export {
  MapTile,
  NeighborDirection,
  DEFAULT_EROSION_CONFIG,
  DEFAULT_TILE_CONFIG,
} from './MapTile'
export type { TileConfig, ErosionConfig } from './MapTile'
export { TileManager } from './TileManager'
export { CameraController } from './camera-controller'
export type { CameraSettings } from './camera-controller'
export {
  TerrainPainter,
  DEFAULT_TERRAIN_PAINTER_CONFIG,
} from './terrain-painter'
export type { TerrainPainterConfig, ColorRule } from './terrain-painter'

// Cartoon shader exports
export {
  createCartoonMaterial,
  createOutlineMaterial,
  updateCartoonMaterial,
  updateOutlineMaterial,
  setCartoonLightDirection,
  CartoonMeshGroup,
  DEFAULT_CARTOON_CONFIG,
  DEFAULT_OUTLINE_CONFIG,
  DEFAULT_SHADING_CONFIG,
} from './CartoonMaterial'
export type {
  CartoonConfig,
  CartoonOutlineConfig,
  CartoonShadingConfig,
} from './CartoonMaterial'

export class Map {
  public static scene: THREE.Scene
  public static perspectiveCamera: THREE.PerspectiveCamera
  public static renderer: THREE.WebGLRenderer
  public static cameraController: CameraController
  public static tileManager: TileManager

  private animationFrameId: number | null = null

  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container

    Map.scene = new THREE.Scene()
    Map.scene.background = new THREE.Color(0x87ceeb) // Sky blue background

    Map.perspectiveCamera = new THREE.PerspectiveCamera(
      75,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      1000
    )
    // Position camera above and looking down
    Map.perspectiveCamera.position.set(0, 25, 0)
    Map.perspectiveCamera.lookAt(0, 0, 0)

    Map.renderer = new THREE.WebGLRenderer({ antialias: true })
    Map.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight
    )
    Map.renderer.setPixelRatio(window.devicePixelRatio)

    Map.renderer.toneMapping = THREE.CineonToneMapping
    Map.renderer.toneMappingExposure = 1.75
    Map.renderer.shadowMap.enabled = false
    Map.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.container.appendChild(Map.renderer.domElement)

    // Use custom camera controller for WASD + mouse + scroll control
    Map.cameraController = new CameraController(
      Map.perspectiveCamera,
      Map.renderer.domElement,
      {
        moveSpeed: 20,
        dragSpeed: 0.01,
        zoomSpeed: 2,
        rotateSpeed: 0.3,
        minZoom: 5,
        maxZoom: 200,
        minPitch: 45, // Minimum angle from horizontal
        maxPitch: 90, // Maximum angle (looking straight down)
        initialPitch: 50, // Start at 45 degrees
        initialYaw: 0, // Start facing north
        isometric: false, // Set to true for isometric projection
        isometricScale: 30, // Scale factor for isometric view
      }
    )

    // Initialize tile manager
    Map.tileManager = new TileManager(Map.scene, {
      tileConfig: {
        map: deserializeFloat32Array(localStorage.getItem('map') ?? ''),
        width: 512,
        sizeScale: 16,
        size: 32,
        segments: 64,
        noiseScale: 32,
        heightScale: 16,
        seed: 12345,
        erosion: {
          enabled: true,
          iterations: 6000,
          inertia: 0.05,
          capacity: 4,
          deposition: 0.1,
          erosion: 0.1,
          evaporation: 0.02,
          radius: 3,
          minSlope: 0.01,
          gravity: 4,
        },
        overlapSegments: 16, // Overlap with neighbors (for seamless erosion)
        showOverlap: false, // Set to true to visualize overlap areas
        painter: DEFAULT_TERRAIN_PAINTER_CONFIG, // Terrain painting configuration
        cartoon: DEFAULT_CARTOON_CONFIG, // Cartoon shader configuration
      },
      loadDistance: 8,
      unloadDistance: 64,
      maxTilesPerFrame: 3, // Reduced due to erosion processing time
      maxBlendsPerFrame: 6, // Max blend operations per frame
    })

    // Initial tile load
    const activeCamera = Map.cameraController.getActiveCamera()
    Map.tileManager.forceLoadAll(
      activeCamera.position.x,
      activeCamera.position.z
    )

    this.addLighting()

    this.addBasicGeometry()

    this.setupResizeHandler()

    this.animate()
  }

  /**
   * Add lighting to the scene
   * Three.js requires lights to make materials visible
   */
  private addLighting(): void {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5)
    Map.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(10, 10, 5)
    directionalLight.castShadow = false
    directionalLight.shadow.mapSize.width = 4096
    directionalLight.shadow.mapSize.height = 4096
    Map.scene.add(directionalLight)

    const hemisphereLight = new THREE.HemisphereLight(0x4488aa, 0xcc8866, 0.3)
    Map.scene.add(hemisphereLight)
  }

  /**
   * Add basic 3D geometry to demonstrate the scene
   */
  private addBasicGeometry(): void {
    // const geometry = new THREE.PlaneGeometry(5, 5) // width = 5, height = 5
    // const material = new THREE.MeshBasicMaterial({
    //   color: 0x4aabe9,
    //   side: THREE.DoubleSide,
    // })
    // const plane = new THREE.Mesh(geometry, material)
    // plane.scale.set(1000, 1000, 1000)
    // plane.position.set(0, 0.01, 0)
    // plane.rotation.x = Math.PI / 2
    // Map.scene.add(plane)
    // const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x888888)
    // Map.scene.add(gridHelper)
    // const axesHelper = new THREE.AxesHelper(5)
    // Map.scene.add(axesHelper)
  }

  /**
   * Set up window resize handler to maintain proper aspect ratio
   */
  private setupResizeHandler(): void {
    const handleResize = () => {
      const width = this.container.clientWidth
      const height = this.container.clientHeight

      // Update camera controller (handles both perspective and orthographic)
      Map.cameraController.updateAspect(width, height)

      Map.renderer.setSize(width, height)
    }

    window.addEventListener('resize', handleResize)

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(this.container)
    }

    handleResize()
  }

  /**
   * Animation loop - called every frame
   */
  private animate(): void {
    this.animationFrameId = requestAnimationFrame(() => this.animate())

    Map.cameraController.update()

    // Get active camera for rendering
    const activeCamera = Map.cameraController.getActiveCamera()

    // Update tile manager with camera position
    Map.tileManager.update(activeCamera.position.x, activeCamera.position.z)

    Map.renderer.render(Map.scene, activeCamera)
  }

  /**
   * Public method to add objects to the scene
   * @param object - Three.js object to add to the scene
   */
  public addToScene(object: THREE.Object3D): void {
    Map.scene.add(object)
  }

  /**
   * Public method to remove objects from the scene
   * @param object - Three.js object to remove from the scene
   */
  public removeFromScene(object: THREE.Object3D): void {
    Map.scene.remove(object)
  }

  /**
   * Get the Three.js scene instance
   * @returns The Three.js scene
   */
  public getScene(): THREE.Scene {
    return Map.scene
  }

  /**
   * Get the active camera instance
   * @returns The Three.js camera (perspective or orthographic)
   */
  public getCamera(): THREE.Camera {
    return Map.cameraController.getActiveCamera()
  }

  /**
   * Get the perspective camera instance
   * @returns The Three.js perspective camera
   */
  public getPerspectiveCamera(): THREE.PerspectiveCamera {
    return Map.perspectiveCamera
  }

  /**
   * Get the renderer instance
   * @returns The Three.js renderer
   */
  public getRenderer(): THREE.WebGLRenderer {
    return Map.renderer
  }

  /**
   * Get the camera controller instance
   * @returns The CameraController
   */
  public getCameraController(): CameraController {
    return Map.cameraController
  }

  /**
   * Clean up resources to prevent memory leaks
   * Call this when destroying the scene
   */
  public dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
    }

    Map.cameraController.dispose()
    Map.tileManager.dispose()

    Map.renderer.dispose()

    window.removeEventListener('resize', () => {})

    if (Map.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(Map.renderer.domElement)
    }

    if (!this.container.id && this.container.parentNode === document.body) {
      document.body.removeChild(this.container)
    }
  }

  /**
   * Update scene dimensions manually (useful for container size changes)
   */
  public updateSize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    Map.cameraController.updateAspect(width, height)
    Map.renderer.setSize(width, height)
  }

  public static createLine(
    startPoint: THREE.Vector3,
    endPoint: THREE.Vector3,
    color: number | string | THREE.Color = 0xff0000,
    lineWidth: number = 2
  ): THREE.Line {
    const geometry = new THREE.BufferGeometry()

    const points = [startPoint, endPoint]

    const positions = new Float32Array(points.length * 3)
    points.forEach((point, i) => {
      positions[i * 3] = point.x
      positions[i * 3 + 1] = point.y
      positions[i * 3 + 2] = point.z
    })

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const material = new THREE.LineBasicMaterial({
      color: color,
      linewidth: lineWidth,
      linecap: 'round',
      linejoin: 'round',
    })

    const line = new THREE.Line(geometry, material)

    return line
  }
}
