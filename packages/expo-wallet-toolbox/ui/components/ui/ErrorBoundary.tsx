import React, { Component, ErrorInfo, ReactNode } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

/**
 * Error Boundary to catch JavaScript errors and prevent app crashes
 * This is especially important for production builds where crashes are more severe
 *
 * Styling here is deliberately literal -- hex colours and a font name, no
 * imports beyond react-native. This is the screen that renders when something
 * else has already failed, so it must not depend on a theme provider, a token
 * module or a hook that could be part of what broke. The values below are the
 * app's dark palette (src/theme/tokens.ts) copied in by hand for that reason;
 * if that palette moves, this is a known place to update by hand. It stays
 * dark in both schemes because a class component cannot read the scheme hook,
 * and a crash screen that is always the same is easier to recognise anyway.
 *
 * Nunito is embedded at build time (app.config.js), so naming it needs no
 * font loading and cannot fail here. The stack trace stays monospace: it is
 * read as code, column alignment matters more than the brand face.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    }
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
      errorInfo: null
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log the error to console
    console.error('ErrorBoundary caught an error:', error, errorInfo)

    // Update state with error details
    this.setState({
      error,
      errorInfo
    })

    // You can also log the error to an error reporting service here
    // Example: Sentry.captureException(error, { extra: errorInfo })
  }

  resetError = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.contentContainer}>
            <Text style={styles.title}>⚠️ Something went wrong</Text>

            <Text style={styles.message}>The app encountered an unexpected error. Please try restarting.</Text>

            {this.state.error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Error:</Text>
                <Text style={styles.errorText}>{this.state.error.toString()}</Text>
              </View>
            )}

            {this.state.errorInfo && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Stack Trace:</Text>
                <Text style={styles.errorText}>{this.state.errorInfo.componentStack}</Text>
              </View>
            )}

            <TouchableOpacity style={styles.button} onPress={this.resetError}>
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )
    }

    return this.props.children
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0d'
  },
  scrollView: {
    flex: 1
  },
  contentContainer: {
    padding: 20,
    paddingTop: 60
  },
  title: {
    fontFamily: 'Nunito',
    fontSize: 24,
    fontWeight: '700',
    color: '#f75d59',
    marginBottom: 16
  },
  message: {
    fontFamily: 'Nunito',
    fontSize: 16,
    color: '#f3f3f1',
    marginBottom: 24,
    lineHeight: 24
  },
  errorBox: {
    backgroundColor: '#161619',
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#f75d59'
  },
  errorTitle: {
    fontFamily: 'Nunito',
    fontSize: 14,
    fontWeight: '700',
    color: '#f75d59',
    marginBottom: 8
  },
  errorText: {
    fontSize: 12,
    color: '#98989c',
    fontFamily: 'monospace',
    lineHeight: 18
  },
  button: {
    backgroundColor: '#f3f3f1',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16
  },
  buttonText: {
    fontFamily: 'Nunito',
    color: '#2d2d31',
    fontSize: 16,
    fontWeight: '700'
  }
})
