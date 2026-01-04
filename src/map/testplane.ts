import { Map } from '.'
import { Erosion } from '../utils/erosion'
import { PerlinNoise } from '../utils/perlin-noise'
import * as THREE from 'three'

export default class TestPlane {
  private perlinNoise = new PerlinNoise()
  private erosion = new Erosion()

  constructor() {}

  create() {
    // 1. Define Dimensions
    const A = 32 // Width (x)
    const B = 32 // Height/Depth (z)

    // Define the resolution (Grid of vertices)
    // 1x1 segment = 4 vertices (2 triangles)
    const widthSegments = 128
    const heightSegments = 128

    // 2. Create the Vertex Array
    // You need (segments + 1) points along each axis
    const vertices: number[] = []
    const widthCount = widthSegments + 1
    const heightCount = heightSegments + 1

    // Temporary heightmap for erosion
    const heightMap = new Float32Array(widthCount * heightCount)

    for (let i = 0; i < heightCount; i++) {
      // Calculate Z position (0 to B)
      // We use 'i' for the depth loop
      const z = (i / heightSegments) * B

      for (let j = 0; j < widthCount; j++) {
        // Calculate X position (0 to A)
        // We use 'j' for the width loop
        const x = (j / widthSegments) * A

        // Y is usually 0 for a flat plan
        const y = this.perlinNoise.noise2D(z / 8, x / 8) * 4

        // Store in heightmap
        heightMap[i * widthCount + j] = y

        // Push to array (x, y, z)
        vertices.push(x, y, z)
      }
    }

    // Apply Erosion
    console.time('Erosion')
    this.erosion.erode(heightMap, widthCount, heightCount, 20000)
    console.timeEnd('Erosion')

    // Update vertices with new heights
    for (let i = 0; i < heightCount; i++) {
      for (let j = 0; j < widthCount; j++) {
        const index = (i * widthCount + j) * 3
        vertices[index + 1] = heightMap[i * widthCount + j]
      }
    }

    // 3. Create the Index Array (Topology)
    // This tells Three.js how to connect the dots to make triangles
    const indices = []

    for (let i = 0; i < heightSegments; i++) {
      for (let j = 0; j < widthSegments; j++) {
        // Current vertex index
        const a = i * widthCount + j
        const b = i * widthCount + j + 1
        const c = (i + 1) * widthCount + j
        const d = (i + 1) * widthCount + j + 1

        // Generate two triangles for each grid square
        // Triangle 1: a -> b -> d
        indices.push(a, b, d)
        // Triangle 2: a -> d -> c
        indices.push(a, d, c)
      }
    }

    // 4. Create Geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(vertices, 3)
    )
    geometry.setIndex(indices)
    geometry.computeVertexNormals() // Crucial for lighting to work

    // 5. Create Material and Mesh
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      wireframe: true,
      flatShading: false,
    })

    const plane = new THREE.Mesh(geometry, material)

    // 6. Add to Scene
    Map.scene.add(plane)

    // Optional: Center the mesh based on A and B
    plane.position.x = -A / 2
    plane.position.z = -B / 2

    // ... Camera and Renderer setup ...
  }
}
