import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export class Map {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls

  private animationFrameId: number | null = null

  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x202020)

    this.camera = new THREE.PerspectiveCamera(
      75,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      1000
    )
    this.camera.position.set(5, 5, 5)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(
      this.container.clientWidth,
      this.container.clientHeight
    )
    this.renderer.setPixelRatio(window.devicePixelRatio)

    this.container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)

    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.rotateSpeed = 0.5
    this.controls.zoomSpeed = 0.5
    this.controls.panSpeed = 0.5
    this.controls.maxDistance = 50
    this.controls.minDistance = 1

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
    this.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(10, 10, 5)
    this.scene.add(directionalLight)

    const hemisphereLight = new THREE.HemisphereLight(0x4488aa, 0xcc8866, 0.3)
    this.scene.add(hemisphereLight)
  }

  /**
   * Add basic 3D geometry to demonstrate the scene
   */
  private addBasicGeometry(): void {
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x888888)
    this.scene.add(gridHelper)

    const axesHelper = new THREE.AxesHelper(5)
    this.scene.add(axesHelper)
  }

  /**
   * Set up window resize handler to maintain proper aspect ratio
   */
  private setupResizeHandler(): void {
    const handleResize = () => {
      this.camera.aspect =
        this.container.clientWidth / this.container.clientHeight
      this.camera.updateProjectionMatrix()

      this.renderer.setSize(
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

    this.controls.update()

    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Public method to add objects to the scene
   * @param object - Three.js object to add to the scene
   */
  public addToScene(object: THREE.Object3D): void {
    this.scene.add(object)
  }

  /**
   * Public method to remove objects from the scene
   * @param object - Three.js object to remove from the scene
   */
  public removeFromScene(object: THREE.Object3D): void {
    this.scene.remove(object)
  }

  /**
   * Get the Three.js scene instance
   * @returns The Three.js scene
   */
  public getScene(): THREE.Scene {
    return this.scene
  }

  /**
   * Get the camera instance
   * @returns The Three.js camera
   */
  public getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  /**
   * Get the renderer instance
   * @returns The Three.js renderer
   */
  public getRenderer(): THREE.WebGLRenderer {
    return this.renderer
  }

  /**
   * Get the controls instance
   * @returns The OrbitControls
   */
  public getControls(): OrbitControls {
    return this.controls
  }

  /**
   * Clean up resources to prevent memory leaks
   * Call this when destroying the scene
   */
  public dispose(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
    }

    this.controls.dispose()

    this.renderer.dispose()

    window.removeEventListener('resize', () => {})

    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }

    if (!this.container.id && this.container.parentNode === document.body) {
      document.body.removeChild(this.container)
    }
  }

  /**
   * Update scene dimensions manually (useful for container size changes)
   */
  public updateSize(): void {
    this.camera.aspect =
      this.container.clientWidth / this.container.clientHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(
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
