/**
 * HIG action sheet for 3+ choices the person just initiated.
 *
 * iOS uses ActionSheetIOS (destructive first, cancel last). Android stacks the
 * same options via showAlert — AlertCard already stacks 3+.
 */
import { ActionSheetIOS, Platform } from 'react-native'
import { showAlert } from './AlertCard'

export function choiceSheetOrder<T extends { key: string; destructive?: boolean }>(
  options: T[],
  cancelKey = 'cancel'
): Array<T | { key: string }> {
  const destructive = options.filter(o => o.destructive)
  const rest = options.filter(o => !o.destructive)
  return [...destructive, ...rest, { key: cancelKey }]
}

export async function showChoiceSheet(args: {
  title: string
  message?: string
  options: { key: string; label: string; destructive?: boolean }[]
  cancelKey?: string
  cancelLabel?: string
}): Promise<string> {
  const cancelKey = args.cancelKey ?? 'cancel'
  const cancelLabel = args.cancelLabel ?? 'Cancel'
  const ordered = choiceSheetOrder(args.options, cancelKey)
  const labelFor = (key: string) =>
    key === cancelKey ? cancelLabel : (args.options.find(o => o.key === key)?.label ?? key)
  const destructiveIndexes = ordered.flatMap((o, i) =>
    'destructive' in o && o.destructive ? [i] : []
  )

  if (Platform.OS === 'ios') {
    return new Promise(resolve => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: args.title,
          message: args.message,
          options: ordered.map(o => labelFor(o.key)),
          cancelButtonIndex: ordered.length - 1,
          destructiveButtonIndex:
            destructiveIndexes.length === 1
              ? destructiveIndexes[0]
              : destructiveIndexes.length > 1
                ? destructiveIndexes
                : undefined
        },
        buttonIndex => {
          resolve(ordered[buttonIndex]?.key ?? cancelKey)
        }
      )
    })
  }

  return showAlert({
    title: args.title,
    message: args.message,
    buttons: ordered.map(o => {
      const destructive = 'destructive' in o && o.destructive
      return {
        text: labelFor(o.key),
        key: o.key,
        style: o.key === cancelKey ? 'cancel' : destructive ? 'destructive' : 'default'
      }
    })
  })
}
