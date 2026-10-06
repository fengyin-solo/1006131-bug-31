/** 极小断言：不引入 vitest（离线环境装不了），失败直接抛错带位置。 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
