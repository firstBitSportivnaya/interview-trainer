/**
 * Запись без времени. Тест сверяет смысл, а не часы машины:
 * время записи проверяется отдельным тестом.
 */
export function withoutTime<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => withoutTime(item)) as T;
  }
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "createdAt") {
        continue;
      }
      copy[key] = withoutTime(item);
    }
    return copy as T;
  }
  return value;
}
