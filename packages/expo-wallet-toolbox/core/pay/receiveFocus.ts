/**
 * Whether HandleReceive is the focused screen. Background credit uses this so
 * it does not toast over the overlay that screen already owns.
 */
let receiveInboxFocused = false

export function setReceiveInboxFocused(focused: boolean): void {
  receiveInboxFocused = focused
}

export function isReceiveInboxFocused(): boolean {
  return receiveInboxFocused
}
