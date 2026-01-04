import { TileManager } from './TileManager'
import { CameraController } from './camera-controller'
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

export class Map {
  public static scene: THREE.Scene
  public static camera: THREE.PerspectiveCamera
  public static renderer: THREE.WebGLRenderer
  public static cameraController: CameraController
  public static tileManager: TileManager

  private animationFrameId: number | null = null

  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container

    Map.scene = new THREE.Scene()
    Map.scene.background = new THREE.Color(0x87ceeb) // Sky blue background

    Map.camera = new THREE.PerspectiveCamera(
      75,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      1000
    )
    // Position camera above and looking down
    Map.camera.position.set(0, 25, 0)
    Map.camera.lookAt(0, 0, 0)

    Map.renderer = new THREE.WebGLRenderer({ antialias: true })
    Map.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight
    )
    Map.renderer.setPixelRatio(window.devicePixelRatio)

    this.container.appendChild(Map.renderer.domElement)

    // Use custom camera controller for WASD + mouse + scroll control
    Map.cameraController = new CameraController(
      Map.camera,
      Map.renderer.domElement
    )

    // Initialize tile manager
    Map.tileManager = new TileManager(Map.scene, {
      tileConfig: {
        size: 32,
        segments: 64,
        noiseScale: 8,
        heightScale: 4,
        seed: 12345,
        erosion: {
          enabled: true,
          iterations: 3000,
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
        showOverlap: true, // Set to true to visualize overlap areas
      },
      loadDistance: 4,
      unloadDistance: 6,
      maxTilesPerFrame: 1, // Reduced due to erosion processing time
      maxBlendsPerFrame: 2, // Max blend operations per frame
    })

    // Initial tile load
    Map.tileManager.forceLoadAll(Map.camera.position.x, Map.camera.position.z)

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
    Map.scene.add(directionalLight)

    const hemisphereLight = new THREE.HemisphereLight(0x4488aa, 0xcc8866, 0.3)
    Map.scene.add(hemisphereLight)
  }

  /**
   * Add basic 3D geometry to demonstrate the scene
   */
  private addBasicGeometry(): void {
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
      Map.camera.aspect =
        this.container.clientWidth / this.container.clientHeight
      Map.camera.updateProjectionMatrix()

      Map.renderer.setSize(
        this.container.clientWidth,
        this.container.clientHeight
      )
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

    // Update tile manager with camera position
    Map.tileManager.update(Map.camera.position.x, Map.camera.position.z)

    Map.renderer.render(Map.scene, Map.camera)
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
   * Get the camera instance
   * @returns The Three.js camera
   */
  public getCamera(): THREE.PerspectiveCamera {
    return Map.camera
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
    Map.camera.aspect = this.container.clientWidth / this.container.clientHeight
    Map.camera.updateProjectionMatrix()
    Map.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight
    )
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
