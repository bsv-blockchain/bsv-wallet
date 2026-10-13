// A toast with Undo (the prototype's sonner toasts with an action): "Ana
// deleted · Undo", from anywhere. Just a toast with an action now
// (src/ui/Toast.tsx): the same card, 4 seconds, the inverted chip on the right.
import { showToast } from './Toast'

export function showUndo(message: string, onUndo: () => void) {
  showToast(message, { action: { label: 'Undo', onPress: onUndo } })
}
