import * as THREE from 'three'

export interface CameraSettings {
  moveSpeed: number
  dragSpeed: number
  zoomSpeed: number
  rotateSpeed: number
  minZoom: number
  maxZoom: number
  minPitch: number // Minimum pitch angle in degrees (0 = looking down)
  maxPitch: number // Maximum pitch angle in degrees (90 = looking horizontal)
  initialPitch: number // Initial pitch angle in degrees
  initialYaw: number // Initial yaw angle in degrees
  isometric: boolean // Enable isometric projection mode
  isometricScale: number // Scale factor for orthographic camera (world units visible)
}

const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  moveSpeed: 10,
  dragSpeed: 0.01,
  zoomSpeed: 2,
  rotateSpeed: 0.3,
  minZoom: 2,
  maxZoom: 50,
  minPitch: 10, // Minimum 10 degrees from horizontal
  maxPitch: 90, // Maximum 90 degrees (looking straight down)
  initialPitch: 60, // Start at 60 degrees
  initialYaw: 0, // Start facing north
  isometric: false, // Default to perspective projection
  isometricScale: 30, // Default scale for orthographic view
}

export class CameraController {
  private perspectiveCamera: THREE.PerspectiveCamera
  private orthographicCamera: THREE.OrthographicCamera
  private activeCamera: THREE.Camera
  private domElement: HTMLElement

  // Movement state
  private keys = { w: false, a: false, s: false, d: false, q: false, e: false }

  // Mouse state
  private isDragging = false
  private isRotating = false
  private previousMousePosition = { x: 0, y: 0 }

  // Camera settings
  private settings: CameraSettings

  // Target values for smooth interpolation
  private targetPosition: THREE.Vector3
  private targetZoom: number
  private targetPitch: number // Angle in degrees (0-90, 90 = looking down)
  private targetYaw: number // Angle in degrees (0-360)

  // Current values
  private currentPitch: number
  private currentYaw: number
  private currentZoom: number

  // The point the camera is looking at (on the ground)
  private lookAtPoint: THREE.Vector3

  // Track if camera needs update
  private needsUpdate = true

  // Last applied values (to detect actual changes)
  private lastAppliedX = 0
  private lastAppliedZ = 0
  private lastAppliedPitch = 0
  private lastAppliedYaw = 0
  private lastAppliedZoom = 0

  // Isometric mode state
  private _isIsometric: boolean
  private currentScale: number
  private targetScale: number

  // Clock for delta time
  private clock = new THREE.Clock()

  // Callback for camera change
  private onCameraChange?: (camera: THREE.Camera) => void

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    settings: Partial<CameraSettings> = {},
    onCameraChange?: (camera: THREE.Camera) => void
  ) {
    this.perspectiveCamera = camera
    this.domElement = domElement
    this.settings = { ...DEFAULT_CAMERA_SETTINGS, ...settings }
    this.onCameraChange = onCameraChange

    // Create orthographic camera for isometric view
    const aspect = domElement.clientWidth / domElement.clientHeight
    const scale = this.settings.isometricScale
    this.orthographicCamera = new THREE.OrthographicCamera(
      -scale * aspect,
      scale * aspect,
      scale,
      -scale,
      0.1,
      1000
    )

    // Initialize isometric state
    this._isIsometric = this.settings.isometric
    this.currentScale = scale
    this.targetScale = scale
    this.activeCamera = this._isIsometric
      ? this.orthographicCamera
      : this.perspectiveCamera

    // Initialize angles
    this.targetPitch = this.settings.initialPitch
    this.targetYaw = this.settings.initialYaw
    this.currentPitch = this.targetPitch
    this.currentYaw = this.targetYaw

    // Initialize positions
    this.lookAtPoint = new THREE.Vector3(
      camera.position.x,
      0,
      camera.position.z
    )
    this.targetPosition = this.lookAtPoint.clone()
    this.targetZoom = camera.position.y
    this.currentZoom = this.targetZoom

    // Apply initial camera position based on angles
    this.updateCameraFromAngles()

    this.setupEventListeners()
  }

  /**
   * Get the currently active camera
   */
  public getActiveCamera(): THREE.Camera {
    return this.activeCamera
  }

  /**
   * Check if currently in isometric mode
   */
  public get isIsometric(): boolean {
    return this._isIsometric
  }

  /**
   * Toggle isometric projection mode
   */
  public setIsometric(enabled: boolean): void {
    if (this._isIsometric === enabled) return

    this._isIsometric = enabled
    this.activeCamera = enabled
      ? this.orthographicCamera
      : this.perspectiveCamera

    // Force camera update
    this.needsUpdate = true
    this.updateCameraPosition(this.currentZoom)

    // Notify about camera change
    if (this.onCameraChange) {
      this.onCameraChange(this.activeCamera)
    }
  }

  /**
   * Toggle between perspective and isometric
   */
  public toggleProjection(): void {
    this.setIsometric(!this._isIsometric)
  }

  /**
   * Update orthographic camera frustum on resize
   */
  public updateAspect(width: number, height: number): void {
    const aspect = width / height

    // Update perspective camera
    this.perspectiveCamera.aspect = aspect
    this.perspectiveCamera.updateProjectionMatrix()

    // Update orthographic camera
    const scale = this.currentScale
    this.orthographicCamera.left = -scale * aspect
    this.orthographicCamera.right = scale * aspect
    this.orthographicCamera.top = scale
    this.orthographicCamera.bottom = -scale
    this.orthographicCamera.updateProjectionMatrix()
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

    // Toggle isometric projection with 'i' key
    if (key === 'i') {
      this.toggleProjection()
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    const key = event.key.toLowerCase()
    if (key in this.keys) {
      this.keys[key as keyof typeof this.keys] = false
    }
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button === 0) {
      // Left mouse button - pan
      this.isDragging = true
      this.previousMousePosition = { x: event.clientX, y: event.clientY }
    } else if (event.button === 2) {
      // Right mouse button - rotate
      this.isRotating = true
      this.previousMousePosition = { x: event.clientX, y: event.clientY }
    } else if (event.button === 1) {
      // Middle mouse button - pan
      this.isDragging = true
      this.previousMousePosition = { x: event.clientX, y: event.clientY }
    }
  }

  private onMouseMove(event: MouseEvent): void {
    const deltaX = event.clientX - this.previousMousePosition.x
    const deltaY = event.clientY - this.previousMousePosition.y

    if (this.isDragging) {
      // Pan camera - move in the direction the camera is facing
      const zoomFactor =
        (this._isIsometric ? this.currentScale : this.currentZoom) *
        this.settings.dragSpeed

      // Calculate movement direction based on yaw
      const yawRad = (this.currentYaw * Math.PI) / 180
      const cosYaw = Math.cos(yawRad)
      const sinYaw = Math.sin(yawRad)

      // Move relative to camera orientation
      const moveX = -deltaX * cosYaw - deltaY * sinYaw
      const moveZ = deltaX * sinYaw - deltaY * cosYaw

      this.targetPosition.x += moveX * zoomFactor
      this.targetPosition.z += moveZ * zoomFactor
    }

    if (this.isRotating) {
      // Rotate camera
      this.targetYaw -= deltaX * this.settings.rotateSpeed
      this.targetPitch += deltaY * this.settings.rotateSpeed

      // Clamp pitch
      this.targetPitch = THREE.MathUtils.clamp(
        this.targetPitch,
        this.settings.minPitch,
        this.settings.maxPitch
      )

      // Normalize yaw to 0-360
      this.targetYaw = ((this.targetYaw % 360) + 360) % 360
    }

    this.previousMousePosition = { x: event.clientX, y: event.clientY }
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button === 0 || event.button === 1) {
      this.isDragging = false
    }
    if (event.button === 2) {
      this.isRotating = false
    }
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault()

    if (this._isIsometric) {
      // In isometric mode, zoom affects the scale
      const scaleDelta = event.deltaY * 0.02 * this.settings.zoomSpeed
      this.targetScale = THREE.MathUtils.clamp(
        this.targetScale + scaleDelta,
        this.settings.minZoom,
        this.settings.maxZoom * 2
      )
    } else {
      // In perspective mode, zoom affects the distance
      const zoomDelta = event.deltaY * 0.01 * this.settings.zoomSpeed
      this.targetZoom = THREE.MathUtils.clamp(
        this.targetZoom + zoomDelta,
        this.settings.minZoom,
        this.settings.maxZoom
      )
    }
    this.needsUpdate = true
  }

  public update(): void {
    const delta = this.clock.getDelta()

    // Check if any input is active
    const hasInput =
      this.keys.w ||
      this.keys.s ||
      this.keys.a ||
      this.keys.d ||
      this.keys.q ||
      this.keys.e ||
      this.isDragging ||
      this.isRotating

    // Handle WASD movement relative to camera orientation
    if (hasInput) {
      const moveAmount =
        this.settings.moveSpeed * delta * (this.currentZoom / 10)

      // Calculate movement direction based on yaw
      const yawRad = (this.currentYaw * Math.PI) / 180
      const forwardX = Math.sin(yawRad)
      const forwardZ = Math.cos(yawRad)
      const rightX = Math.cos(yawRad)
      const rightZ = -Math.sin(yawRad)

      if (this.keys.w) {
        this.targetPosition.x -= forwardX * moveAmount
        this.targetPosition.z -= forwardZ * moveAmount
        this.needsUpdate = true
      }
      if (this.keys.s) {
        this.targetPosition.x += forwardX * moveAmount
        this.targetPosition.z += forwardZ * moveAmount
        this.needsUpdate = true
      }
      if (this.keys.a) {
        this.targetPosition.x -= rightX * moveAmount
        this.targetPosition.z -= rightZ * moveAmount
        this.needsUpdate = true
      }
      if (this.keys.d) {
        this.targetPosition.x += rightX * moveAmount
        this.targetPosition.z += rightZ * moveAmount
        this.needsUpdate = true
      }

      // Q/E for rotation
      if (this.keys.q) {
        this.targetYaw += this.settings.rotateSpeed * 2
        this.needsUpdate = true
      }
      if (this.keys.e) {
        this.targetYaw -= this.settings.rotateSpeed * 2
        this.needsUpdate = true
      }

      // Normalize yaw
      this.targetYaw = ((this.targetYaw % 360) + 360) % 360
    }

    // Check if we need to interpolate
    const positionThreshold = 0.0001
    const angleThreshold = 0.001
    const zoomThreshold = 0.001

    const posXDiff = Math.abs(this.lookAtPoint.x - this.targetPosition.x)
    const posZDiff = Math.abs(this.lookAtPoint.z - this.targetPosition.z)
    const pitchDiff = Math.abs(this.currentPitch - this.targetPitch)
    const zoomDiff = Math.abs(this.currentZoom - this.targetZoom)
    const scaleDiff = Math.abs(this.currentScale - this.targetScale)

    // Calculate yaw difference with wrap-around
    let yawDiff = this.targetYaw - this.currentYaw
    if (yawDiff > 180) yawDiff -= 360
    if (yawDiff < -180) yawDiff += 360
    const absYawDiff = Math.abs(yawDiff)

    // Check if any value needs interpolation
    const needsInterpolation =
      posXDiff > positionThreshold ||
      posZDiff > positionThreshold ||
      pitchDiff > angleThreshold ||
      absYawDiff > angleThreshold ||
      zoomDiff > zoomThreshold ||
      scaleDiff > zoomThreshold

    if (!needsInterpolation && !this.needsUpdate) {
      // Nothing to update, camera is stable
      return
    }

    // Smoothly interpolate values
    const lerpFactor = 1 - Math.pow(0.001, delta)

    // Interpolate position
    if (posXDiff > positionThreshold) {
      this.lookAtPoint.x = THREE.MathUtils.lerp(
        this.lookAtPoint.x,
        this.targetPosition.x,
        lerpFactor
      )
    } else {
      this.lookAtPoint.x = this.targetPosition.x
    }

    if (posZDiff > positionThreshold) {
      this.lookAtPoint.z = THREE.MathUtils.lerp(
        this.lookAtPoint.z,
        this.targetPosition.z,
        lerpFactor
      )
    } else {
      this.lookAtPoint.z = this.targetPosition.z
    }

    // Interpolate pitch
    if (pitchDiff > angleThreshold) {
      this.currentPitch = THREE.MathUtils.lerp(
        this.currentPitch,
        this.targetPitch,
        lerpFactor
      )
    } else {
      this.currentPitch = this.targetPitch
    }

    // Interpolate yaw
    if (absYawDiff > angleThreshold) {
      this.currentYaw += yawDiff * lerpFactor
      this.currentYaw = ((this.currentYaw % 360) + 360) % 360
    } else {
      this.currentYaw = this.targetYaw
    }

    // Interpolate zoom
    if (zoomDiff > zoomThreshold) {
      this.currentZoom = THREE.MathUtils.lerp(
        this.currentZoom,
        this.targetZoom,
        lerpFactor
      )
    } else {
      this.currentZoom = this.targetZoom
    }

    // Interpolate scale (for isometric mode)
    if (scaleDiff > zoomThreshold) {
      this.currentScale = THREE.MathUtils.lerp(
        this.currentScale,
        this.targetScale,
        lerpFactor
      )
    } else {
      this.currentScale = this.targetScale
    }

    // Check if camera position actually changed
    const epsilon = 0.00001
    const posChanged =
      Math.abs(this.lookAtPoint.x - this.lastAppliedX) > epsilon ||
      Math.abs(this.lookAtPoint.z - this.lastAppliedZ) > epsilon ||
      Math.abs(this.currentPitch - this.lastAppliedPitch) > epsilon ||
      Math.abs(this.currentYaw - this.lastAppliedYaw) > epsilon ||
      Math.abs(this.currentZoom - this.lastAppliedZoom) > epsilon ||
      scaleDiff > epsilon

    if (posChanged) {
      // Update camera position based on angles and zoom
      this.updateCameraPosition(this.currentZoom)

      // Store last applied values
      this.lastAppliedX = this.lookAtPoint.x
      this.lastAppliedZ = this.lookAtPoint.z
      this.lastAppliedPitch = this.currentPitch
      this.lastAppliedYaw = this.currentYaw
      this.lastAppliedZoom = this.currentZoom
    }

    // Reset needsUpdate flag
    this.needsUpdate = false
  }

  private updateCameraPosition(distance: number): void {
    // Convert angles to radians
    const pitchRad = (this.currentPitch * Math.PI) / 180
    const yawRad = (this.currentYaw * Math.PI) / 180

    // Calculate camera offset from look-at point
    // Pitch: 90 = looking straight down, 0 = looking horizontal
    const horizontalDist = distance * Math.cos(pitchRad)
    const verticalDist = distance * Math.sin(pitchRad)

    const offsetX = horizontalDist * Math.sin(yawRad)
    const offsetZ = horizontalDist * Math.cos(yawRad)

    if (this._isIsometric) {
      // For orthographic camera, position it far away and use scale for zoom
      const orthoDistance = 200 // Fixed far distance

      const orthoHorizontalDist = orthoDistance * Math.cos(pitchRad)
      const orthoVerticalDist = orthoDistance * Math.sin(pitchRad)

      const orthoOffsetX = orthoHorizontalDist * Math.sin(yawRad)
      const orthoOffsetZ = orthoHorizontalDist * Math.cos(yawRad)

      this.orthographicCamera.position.set(
        this.lookAtPoint.x + orthoOffsetX,
        orthoVerticalDist,
        this.lookAtPoint.z + orthoOffsetZ
      )

      this.orthographicCamera.lookAt(this.lookAtPoint.x, 0, this.lookAtPoint.z)

      // Update orthographic frustum based on scale
      const aspect = this.domElement.clientWidth / this.domElement.clientHeight
      this.orthographicCamera.left = -this.currentScale * aspect
      this.orthographicCamera.right = this.currentScale * aspect
      this.orthographicCamera.top = this.currentScale
      this.orthographicCamera.bottom = -this.currentScale
      this.orthographicCamera.updateProjectionMatrix()
    } else {
      // Set perspective camera position
      this.perspectiveCamera.position.set(
        this.lookAtPoint.x + offsetX,
        verticalDist,
        this.lookAtPoint.z + offsetZ
      )

      // Look at the target point
      this.perspectiveCamera.lookAt(this.lookAtPoint.x, 0, this.lookAtPoint.z)
    }
  }

  private updateCameraFromAngles(): void {
    this.updateCameraPosition(this.targetZoom)
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown.bind(this))
    window.removeEventListener('keyup', this.onKeyUp.bind(this))
    this.domElement.removeEventListener(
      'mousedown',
      this.onMouseDown.bind(this)
    )
    this.domElement.removeEventListener(
      'mousemove',
      this.onMouseMove.bind(this)
    )
    this.domElement.removeEventListener('mouseup', this.onMouseUp.bind(this))
    this.domElement.removeEventListener('mouseleave', this.onMouseUp.bind(this))
    this.domElement.removeEventListener('wheel', this.onWheel.bind(this))
  }

  // Getters
  public getPitch(): number {
    return this.currentPitch
  }

  public getYaw(): number {
    return this.currentYaw
  }

  public getZoom(): number {
    return this.targetZoom
  }

  public getLookAtPoint(): THREE.Vector3 {
    return this.lookAtPoint.clone()
  }

  // Setters for customization
  public setMoveSpeed(speed: number): void {
    this.settings.moveSpeed = speed
  }

  public setDragSpeed(speed: number): void {
    this.settings.dragSpeed = speed
  }

  public setZoomSpeed(speed: number): void {
    this.settings.zoomSpeed = speed
  }

  public setRotateSpeed(speed: number): void {
    this.settings.rotateSpeed = speed
  }

  public setZoomLimits(min: number, max: number): void {
    this.settings.minZoom = min
    this.settings.maxZoom = max
  }

  public setPitchLimits(min: number, max: number): void {
    this.settings.minPitch = min
    this.settings.maxPitch = max
    // Clamp current pitch to new limits
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch, min, max)
  }

  // Set camera angles directly
  public setPitch(degrees: number): void {
    this.targetPitch = THREE.MathUtils.clamp(
      degrees,
      this.settings.minPitch,
      this.settings.maxPitch
    )
  }

  public setYaw(degrees: number): void {
    this.targetYaw = ((degrees % 360) + 360) % 360
  }

  // Move camera to look at specific point
  public lookAt(x: number, z: number): void {
    this.targetPosition.set(x, 0, z)
  }
}
