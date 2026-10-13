// React Native's TextInput with the keyboard in the app's own light or dark.
// The app's theme setting overrides its windows' appearance
// (Appearance.setColorScheme in app/_layout.tsx), but iOS draws the default
// keyboard from the system's, so a light app on a dark phone got a dark
// keyboard. A field that says otherwise still wins.
import React, { forwardRef } from 'react'
import { TextInput as RNTextInput, type TextInputProps } from 'react-native'
import { useIsDark } from '../theme'

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(props, ref) {
  const dark = useIsDark()
  return <RNTextInput keyboardAppearance={dark ? 'dark' : 'light'} {...props} ref={ref} />
})
export type TextInput = RNTextInput
