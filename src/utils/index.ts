// Сериализация Float32Array → строка для localStorage
export function serializeFloat32Array(arr: Float32Array): string {
  const buffer = arr.buffer
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// Десериализация строки → Float32Array
export function deserializeFloat32Array(base64Str: string): Float32Array {
  const binary = atob(base64Str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Float32Array(bytes.buffer)
}

/**
 * Заполняет matrix2 интерполированными значениями из matrix1
 *
 * @param matrix1 - Исходная матрица (Float32Array, значения 0-1)
 * @param width1 - Ширина matrix1
 * @param matrix2 - Целевая матрица для заполнения (Float32Array)
 * @param width2 - Ширина matrix2
 * @param offsetX - Смещение matrix2 относительно matrix1 по X (в координатах matrix1)
 * @param offsetY - Смещение matrix2 относительно matrix1 по Y (в координатах matrix1)
 * @param physicalWidth - Физическая ширина matrix2 в координатах matrix1 (например, 2 если matrix2 помещается в 2 клетки matrix1)
 */
export function fillMatrix2WithInterpolation(
  matrix1: Float32Array,
  width1: number,
  matrix2: Float32Array,
  width2: number,
  offsetX: number,
  offsetY: number,
  physicalWidth: number
): void {
  const height1 = (matrix1.length / width1) | 0
  const height2 = (matrix2.length / width2) | 0

  // Масштаб: сколько единиц matrix1 приходится на один пиксель matrix2
  const scale = physicalWidth / width2

  // Физическая высота matrix2 в координатах matrix1
  const physicalHeight = height2 * scale

  // Предварительно вычисляем границы для оптимизации
  const maxX1 = width1 - 1
  const maxY1 = height1 - 1

  for (let y2 = 0; y2 < height2; y2++) {
    // Позиция в координатах matrix1
    const y1 = offsetY + y2 * scale

    // Целые координаты для интерполяции
    const y1Floor = Math.floor(y1)
    const y1Ceil = Math.min(y1Floor + 1, maxY1)
    const yFrac = y1 - y1Floor

    // Clamp по Y
    const y1FloorClamped = Math.max(0, Math.min(y1Floor, maxY1))
    const y1CeilClamped = Math.max(0, Math.min(y1Ceil, maxY1))

    // Предварительно вычисляем смещения строк
    const rowOffsetFloor = y1FloorClamped * width1
    const rowOffsetCeil = y1CeilClamped * width1

    const row2Offset = y2 * width2

    for (let x2 = 0; x2 < width2; x2++) {
      // Позиция в координатах matrix1
      const x1 = offsetX + x2 * scale

      // Целые координаты для интерполяции
      const x1Floor = Math.floor(x1)
      const x1Ceil = Math.min(x1Floor + 1, maxX1)
      const xFrac = x1 - x1Floor

      // Clamp по X
      const x1FloorClamped = Math.max(0, Math.min(x1Floor, maxX1))
      const x1CeilClamped = Math.max(0, Math.min(x1Ceil, maxX1))

      // Получаем 4 соседних значения из matrix1
      const topLeft = matrix1[rowOffsetFloor + x1FloorClamped]
      const topRight = matrix1[rowOffsetFloor + x1CeilClamped]
      const bottomLeft = matrix1[rowOffsetCeil + x1FloorClamped]
      const bottomRight = matrix1[rowOffsetCeil + x1CeilClamped]

      // Билинейная интерполяция
      const top = topLeft + (topRight - topLeft) * xFrac
      const bottom = bottomLeft + (bottomRight - bottomLeft) * xFrac
      const value = top + (bottom - top) * yFrac

      matrix2[row2Offset + x2] = value
    }
  }
}
