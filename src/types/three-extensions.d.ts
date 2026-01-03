// Declaration for Three.js PointerLockControls example module
declare module 'three/examples/jsm/controls/PointerLockControls' {
  import * as THREE from 'three'
  export class PointerLockControls extends THREE.EventDispatcher {
    constructor(camera: THREE.Camera, domElement?: HTMLElement)
    lock(): void
    unlock(): void
    get isLocked(): boolean
    // other methods can be added as needed
  }
}
