export function isSelectionGesture(hasSelection: boolean, selectionChanged: boolean, movement: number) {
  return hasSelection && (selectionChanged || movement > 4)
}

export function wordPopoverPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const padding = 12
  return {
    left: Math.max(padding, Math.min(x - width / 2, viewportWidth - width - padding)),
    top: Math.max(padding, Math.min(y - height - 12 >= padding ? y - height - 12 : y + 24, viewportHeight - height - padding)),
  }
}
