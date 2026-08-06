export function isDrawioPath(filePath: string): boolean {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = filePath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  return ext === '.drawio';
}
