export default class Random {
  private seed: number
  private current: number

  constructor(seed: number) {
    this.seed = seed
    this.current = seed
  }

  // Linear Congruential Generator (simple but not cryptographically secure)
  next(): number {
    this.current = (this.current * 9301 + 49297) % 233280
    return this.current / 233280
  }

  // Reset to initial seed
  reset(): void {
    this.current = this.seed
  }

  // Get random integer between min (inclusive) and max (exclusive)
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min
  }

  // Get random float between min (inclusive) and max (exclusive)
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min
  }

  // Get random boolean with given probability
  nextBoolean(probability: number = 0.5): boolean {
    return this.next() < probability
  }

  // Get random item from array
  choice<T>(array: T[]): T {
    return array[this.nextInt(0, array.length)]
  }
}
