import * as THREE from 'three'

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vVertexColor; // Добавляем varying для передачи цвета

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    
    // Three.js автоматически передает атрибут 'color' если включен vertexColors
    vVertexColor = color; 
    
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

// 2. Фрагментный шейдер
const fragmentShader = `
  uniform float uLevel;      // Уровень Y
  uniform float uThickness;  // Толщина линии
  uniform vec3 uColor;       // Цвет обводки

  varying vec3 vWorldPosition;
  varying vec3 vVertexColor; // Принимаем цвет из вершинного шейдера

  void main() {
    // Вычисляем расстояние от уровня
    float dist = abs(vWorldPosition.y - uLevel);
    
    // Вычисляем "силе" линии (1.0 = ровно на линии, 0.0 = далеко)
    float outlineFactor = 1.0 - smoothstep(0.0, uThickness, dist);
    
    // СМЕШИВАНИЕ:
    // Если outlineFactor равен 1 (линия), берем uColor.
    // Если outlineFactor равен 0 (поверхность), берем vVertexColor.
    vec3 finalColor = mix(vVertexColor, uColor, outlineFactor);
    
    gl_FragColor = vec4(finalColor, 1.0);
  }
`
// --- ИСПОЛЬЗОВАНИЕ ---

export const material = new THREE.ShaderMaterial({
  uniforms: {
    uLevel: { value: -0.2 }, // Установите нужный уровень
    uThickness: { value: 0.1 }, // Толщина линии
    uColor: { value: new THREE.Color(0x000000) }, // Красный
    uBaseColor: { value: new THREE.Color(0x888888) }, // Серый
  },
  vertexColors: true,
  vertexShader: vertexShader,
  fragmentShader: fragmentShader,
  side: THREE.DoubleSide, // Рисовать с обеих сторон
})
