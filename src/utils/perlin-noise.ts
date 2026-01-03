/**
 * Генератор Perlin Noise
 * Упрощенная реализация для генерации шума
 */
export class PerlinNoise {
  private permutation: number[]
  private p: number[]

  constructor(seed: number = 12345) {
    // Инициализация перестановок на основе seed
    this.permutation = this.generatePermutation(seed)
    this.p = new Array(512)

    for (let i = 0; i < 256; i++) {
      this.p[256 + i] = this.p[i] = this.permutation[i]
    }
  }

  /**
   * Генерация перестановок на основе seed
   */
  private generatePermutation(seed: number): number[] {
    const perm = Array.from({ length: 256 }, (_, i) => i)

    // Простой PRNG на основе seed
    let state = seed
    const random = () => {
      state = (state * 9301 + 49297) % 233280
      return state / 233280
    }

    // Перемешивание Фишера-Йетса
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[perm[i], perm[j]] = [perm[j], perm[i]]
    }

    return perm
  }

  /**
   * Линейная интерполяция
   */
  private lerp(a: number, b: number, t: number): number {
    return a + t * (b - a)
  }

  /**
   * Функция сглаживания
   */
  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
  }

  /**
   * Градиентная функция
   */
  private grad(hash: number, x: number, y: number): number {
    const h = hash & 15
    const u = h < 8 ? x : y
    const v = h < 4 ? y : h === 12 || h === 14 ? x : 0
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
  }

  /**
   * Генерация 2D шума
   */
  noise2D(x: number, y: number): number {
    const X = Math.floor(x) & 255
    const Y = Math.floor(y) & 255

    x -= Math.floor(x)
    y -= Math.floor(y)

    const u = this.fade(x)
    const v = this.fade(y)

    const A = this.p[X] + Y
    const AA = this.p[A]
    const AB = this.p[A + 1]
    const B = this.p[X + 1] + Y
    const BA = this.p[B]
    const BB = this.p[B + 1]

    return this.lerp(
      this.lerp(
        this.grad(this.p[AA], x, y),
        this.grad(this.p[BA], x - 1, y),
        u
      ),
      this.lerp(
        this.grad(this.p[AB], x, y - 1),
        this.grad(this.p[BB], x - 1, y - 1),
        u
      ),
      v
    )
  }

  /**
   * Генерация фрактального шума (с несколькими октавами)
   */
  fractalNoise2D(
    x: number,
    y: number,
    octaves: number = 4,
    persistence: number = 0.5,
    lacunarity: number = 2.0
  ): number {
    let value = 0
    let amplitude = 1
    let frequency = 1
    let maxValue = 0

    for (let i = 0; i < octaves; i++) {
      value += this.noise2D(x * frequency, y * frequency) * amplitude
      maxValue += amplitude
      amplitude *= persistence
      frequency *= lacunarity
    }

    return value / maxValue
  }
}
