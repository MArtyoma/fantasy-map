import * as THREE from 'three'

export class CameraController {
  private camera: THREE.PerspectiveCamera
  private domElement: HTMLElement

  // Movement state
  private keys = {
    w: false,
    a: false,
    s: false,
    d: false,
  }

  // Mouse state
  private isDragging = false
  private previousMousePosition = { x: 0, y: 0 }

  // Camera settings
  private moveSpeed = 10
  private dragSpeed = 0.01
  private zoomSpeed = 2
  private minZoom = 2
  private maxZoom = 50

  // Target position for smooth camera movement
  private targetPosition: THREE.Vector3
  private targetZoom: number

  // Clock for delta time
  private clock = new THREE.Clock()

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera
    this.domElement = domElement
    this.targetPosition = camera.position.clone()
    this.targetZoom = camera.position.y

    this.setupEventListeners()
  }

  private setupEventListeners(): void {
    // Keyboard events
    window.addEventListener('keydown', this.onKeyDown.bind(this))
    window.addEventListener('keyup', this.onKeyUp.bind(this))

    // Mouse events
    this.domElement.addEventListener('mousedown', this.onMouseDown.bind(this))
    this.domElement.addEventListener('mousemove', this.onMouseMove.bind(this))
    this.domElement.addEventListener('mouseup', this.onMouseUp.bind(this))
    this.domElement.addEventListener('mouseleave', this.onMouseUp.bind(this))

    // Scroll event
    this.domElement.addEventListener('wheel', this.onWheel.bind(this), {
      passive: false,
    })

    // Prevent context menu on right click
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase()
    if (key in this.keys) {
      this.keys[key as keyof typeof this.keys] = true
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    const key = event.key.toLowerCase()
    if (key in this.keys) {
      this.keys[key as keyof typeof this.keys] = false
    }
  }

  private onMouseDown(event: MouseEvent): void {
    // Left mouse button (0) or middle mouse button (1)
    if (event.button === 0 || event.button === 1) {
      this.isDragging = true
      this.previousMousePosition = { x: event.clientX, y: event.clientY }
    }
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.isDragging) return

    const deltaX = event.clientX - this.previousMousePosition.x
    const deltaY = event.clientY - this.previousMousePosition.y

    // Calculate movement based on camera height (zoom level)
    const zoomFactor = this.camera.position.y * this.dragSpeed

    // Move camera in opposite direction of mouse movement
    this.targetPosition.x -= deltaX * zoomFactor
    this.targetPosition.z -= deltaY * zoomFactor

    this.previousMousePosition = { x: event.clientX, y: event.clientY }
  }

  private onMouseUp(): void {
    this.isDragging = false
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault()

    // Calculate new zoom level
    const zoomDelta = event.deltaY * 0.01 * this.zoomSpeed
    this.targetZoom = THREE.MathUtils.clamp(
      this.targetZoom + zoomDelta,
      this.minZoom,
      this.maxZoom
    )
  }

  public update(): void {
    const delta = this.clock.getDelta()

    // Handle WASD movement
    const moveAmount = this.moveSpeed * delta * (this.camera.position.y / 10)

    if (this.keys.w) {
      this.targetPosition.z -= moveAmount
    }
    if (this.keys.s) {
      this.targetPosition.z += moveAmount
    }
    if (this.keys.a) {
      this.targetPosition.x -= moveAmount
    }
    if (this.keys.d) {
      this.targetPosition.x += moveAmount
    }

    // Smoothly interpolate camera position
    const lerpFactor = 1 - Math.pow(0.001, delta)

    this.camera.position.x = THREE.MathUtils.lerp(
      this.camera.position.x,
      this.targetPosition.x,
      lerpFactor
    )
    this.camera.position.z = THREE.MathUtils.lerp(
      this.camera.position.z,
      this.targetPosition.z,
      lerpFactor
    )
    this.camera.position.y = THREE.MathUtils.lerp(
      this.camera.position.y,
      this.targetZoom,
      lerpFactor
    )

    // Update target position to match actual camera position
    this.targetPosition.x = this.camera.position.x
    this.targetPosition.z = this.camera.position.z

    // Make camera look at the point below it
    this.camera.lookAt(
      this.camera.position.x,
      0,
      this.camera.position.z
    )
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown.bind(this))
    window.removeEventListener('keyup', this.onKeyUp.bind(this))
    this.domElement.removeEventListener('mousedown', this.onMouseDown.bind(this))
    this.domElement.removeEventListener('mousemove', this.onMouseMove.bind(this))
    this.domElement.removeEventListener('mouseup', this.onMouseUp.bind(this))
    this.domElement.removeEventListener('mouseleave', this.onMouseUp.bind(this))
    this.domElement.removeEventListener('wheel', this.onWheel.bind(this))
  }

  // Setters for customization
  public setMoveSpeed(speed: number): void {
    this.moveSpeed = speed
  }

  public setDragSpeed(speed: number): void {
    this.dragSpeed = speed
  }

  public setZoomSpeed(speed: number): void {
    this.zoomSpeed = speed
  }

  public setZoomLimits(min: number, max: number): void {
    this.minZoom = min
    this.maxZoom = max
  }
}
