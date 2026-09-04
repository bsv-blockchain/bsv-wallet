import { sounds } from '../../core/hooks/useConfirmationSound'

// Routed here by moduleNameMapper — see __tests__/__mocks__/expo-audio.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const audio = require('expo-audio')

/** The module defers everything past the first `await`, so drain the queue. */
const settle = () => new Promise(resolve => setImmediate(resolve))

describe('payment tones', () => {
  beforeEach(() => {
    audio.__reset()
    sounds.release()
    audio.__reset()
  })

  it('paymentReceive returns synchronously — a payment never waits on audio', () => {
    // If this ever returns a promise the call sites would be tempted to await
    // it, and CoreAudio would be on a money path.
    expect(sounds.paymentReceive()).toBeUndefined()
  })

  it('paymentSend returns synchronously', () => {
    expect(sounds.paymentSend()).toBeUndefined()
  })

  it('paymentReceive plays the bundled tone', async () => {
    sounds.paymentReceive()
    await settle()
    expect(audio.__calls.created).toHaveLength(1)
    expect(audio.__calls.played).toBe(1)
  })

  it('paymentSend plays the bundled tone', async () => {
    sounds.paymentSend()
    await settle()
    expect(audio.__calls.created).toHaveLength(1)
    expect(audio.__calls.played).toBe(1)
  })

  // The single most important assertion in this file. A payments app that
  // overrides the ringer switch to announce itself is an app people mute for
  // good — and this plays in shops, on buses, in meetings.
  it('respects the iOS silent switch', async () => {
    sounds.paymentReceive()
    await settle()
    expect(audio.__calls.audioModes[0]).toMatchObject({ playsInSilentMode: false })
  })

  // A 0.6s blip must not pause or duck someone's music.
  it('mixes with other audio rather than taking the session', async () => {
    sounds.paymentReceive()
    await settle()
    expect(audio.__calls.audioModes[0]).toMatchObject({
      interruptionMode: 'mixWithOthers',
      shouldPlayInBackground: false,
    })
  })

  it('configures the audio session once, shared across different tones', async () => {
    sounds.paymentReceive()
    await settle()
    sounds.paymentSend()
    await settle()
    expect(audio.__calls.audioModes).toHaveLength(1)
  })

  it('each tone lazily creates its own player, reused rather than leaking one per payment', async () => {
    sounds.paymentReceive()
    await settle()
    sounds.paymentReceive()
    await settle()
    sounds.paymentSend()
    await settle()
    // Two distinct sources created (one per tone name), paymentReceive's reused on its second call.
    expect(audio.__calls.created).toHaveLength(2)
    expect(audio.__calls.played).toBe(3)
    expect(audio.__calls.sought).toEqual([0, 0, 0])
  })

  it('releases every shared player', async () => {
    sounds.paymentReceive()
    await settle()
    sounds.paymentSend()
    await settle()
    sounds.release()
    expect(audio.__calls.removed).toBe(2)
  })

  // Payments happen in public. A failed sound is not a failed payment, so no
  // failure mode below may reach the caller.
  it('never throws when the audio session cannot be configured', async () => {
    const real = audio.setAudioModeAsync
    audio.setAudioModeAsync = () => Promise.reject(new Error('session busy'))
    try {
      expect(() => sounds.paymentReceive()).not.toThrow()
      await settle()
      expect(audio.__calls.played).toBe(0)
    } finally {
      audio.setAudioModeAsync = real
    }
  })

  it('never throws when the player cannot be created', async () => {
    const real = audio.createAudioPlayer
    audio.createAudioPlayer = () => {
      throw new Error('no decoder')
    }
    try {
      expect(() => sounds.paymentSend()).not.toThrow()
      await settle()
      expect(audio.__calls.played).toBe(0)
    } finally {
      audio.createAudioPlayer = real
    }
  })

  it('never throws when playback itself fails', async () => {
    sounds.paymentReceive()
    await settle()
    audio.__reset()
    // Break the live player the module is holding.
    const broken = audio.AudioPlayer.prototype.play
    audio.AudioPlayer.prototype.play = () => {
      throw new Error('route changed')
    }
    try {
      expect(() => sounds.paymentReceive()).not.toThrow()
      await settle()
    } finally {
      audio.AudioPlayer.prototype.play = broken
    }
  })
})

describe('vault tones', () => {
  beforeEach(() => {
    audio.__reset()
    sounds.release()
    audio.__reset()
  })

  it('vaultOpen and vaultClose return synchronously', () => {
    expect(sounds.vaultOpen()).toBeUndefined()
    expect(sounds.vaultClose()).toBeUndefined()
  })

  it('each tone lazily creates its own player, distinct from the payment tones', async () => {
    sounds.vaultOpen()
    await settle()
    sounds.vaultClose()
    await settle()
    sounds.paymentReceive()
    await settle()
    // three distinct sources created, one per tone
    expect(audio.__calls.created).toHaveLength(3)
    expect(audio.__calls.played).toBe(3)
  })

  it('shares the one-time audio-session config across tones', async () => {
    sounds.vaultOpen()
    await settle()
    sounds.vaultClose()
    await settle()
    expect(audio.__calls.audioModes).toHaveLength(1)
    expect(audio.__calls.audioModes[0]).toMatchObject({
      playsInSilentMode: false,
      interruptionMode: 'mixWithOthers',
    })
  })

  it('reuses each tone player and rewinds it', async () => {
    sounds.vaultOpen()
    await settle()
    sounds.vaultOpen()
    await settle()
    expect(audio.__calls.created).toHaveLength(1)
    expect(audio.__calls.played).toBe(2)
    expect(audio.__calls.sought).toEqual([0, 0])
  })

  it('release removes every tone player', async () => {
    sounds.vaultOpen()
    await settle()
    sounds.vaultClose()
    await settle()
    sounds.release()
    expect(audio.__calls.removed).toBe(2)
  })

  it('never throws when a vault tone cannot be created', async () => {
    const real = audio.createAudioPlayer
    audio.createAudioPlayer = () => {
      throw new Error('no decoder')
    }
    try {
      expect(() => sounds.vaultOpen()).not.toThrow()
      await settle()
      expect(audio.__calls.played).toBe(0)
    } finally {
      audio.createAudioPlayer = real
    }
  })
})
