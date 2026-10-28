import { attestFrame, type Sender } from '../../extension/src/lib/attest'

const sender = (over: Partial<Sender> = {}): Sender => ({
  tab: { id: 7, incognito: false, url: 'https://top.example/' },
  frameId: 0,
  url: 'https://app.example/page',
  origin: 'https://app.example',
  ...over
})
const opts = { allowLocalhostHttp: false }

describe('attestFrame', () => {
  it('https origin accepted, uppercase host refused not normalised', () => {
    expect(attestFrame(sender(), opts)).toEqual({
      origin: 'https://app.example',
      tabId: 7,
      frameId: 0,
      context: 'safari'
    })
    expect(attestFrame(sender({ origin: 'https://APP.example' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ origin: undefined, url: 'https://APP.example/x' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ origin: undefined, url: 'https://app.example/x?q=1' }), opts)?.origin).toBe(
      'https://app.example'
    )
    expect(attestFrame(sender({ origin: undefined, url: 'https://user@app.example/' }), opts)).toBeUndefined()
  })

  it('http://localhost:3000 only with allowLocalhostHttp', () => {
    const s = sender({ origin: 'http://localhost:3000', url: 'http://localhost:3000/' })
    expect(attestFrame(s, opts)).toBeUndefined()
    expect(attestFrame(s, { allowLocalhostHttp: true })?.origin).toBe('http://localhost:3000')
    expect(
      attestFrame(sender({ origin: 'http://example.com', url: 'http://example.com/' }), { allowLocalhostHttp: true })
    ).toBeUndefined()
  })

  it('opaque, about:blank and srcdoc frames give undefined', () => {
    expect(attestFrame(sender({ origin: 'null', url: 'https://app.example/sandboxed' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ url: 'about:blank', origin: 'https://app.example' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ url: 'about:srcdoc', origin: 'https://app.example' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ origin: undefined, url: 'data:text/html,hi' }), opts)).toBeUndefined()
    expect(attestFrame(sender({ origin: undefined, url: undefined }), opts)).toBeUndefined()
    expect(attestFrame({ frameId: 0, origin: 'https://app.example' }, opts)).toBeUndefined() // no tab
  })

  it('frame navigation with the same frameId is re-read', () => {
    const a = attestFrame(sender({ frameId: 3, origin: undefined, url: 'https://one.example/a' }), opts)
    const b = attestFrame(sender({ frameId: 3, origin: undefined, url: 'https://two.example/b' }), opts)
    expect(a?.origin).toBe('https://one.example')
    expect(b?.origin).toBe('https://two.example')
    expect(b?.frameId).toBe(3)
  })

  it('cross-origin iframe never gets the top origin', () => {
    const frame = attestFrame(
      sender({
        frameId: 5,
        origin: undefined,
        url: 'https://ads.example/frame',
        tab: { id: 7, incognito: false, url: 'https://top.example/' }
      }),
      opts
    )
    expect(frame?.origin).toBe('https://ads.example')
    // A frame with no URL of its own gets nothing, not the tab URL.
    expect(attestFrame(sender({ frameId: 5, origin: undefined, url: undefined }), opts)).toBeUndefined()
  })

  it('incognito true or non-boolean gives safari-private', () => {
    expect(attestFrame(sender({ tab: { id: 1, incognito: true } }), opts)?.context).toBe('safari-private')
    expect(attestFrame(sender({ tab: { id: 1, incognito: 'no' as never } }), opts)?.context).toBe('safari-private')
    expect(attestFrame(sender({ tab: { id: 1 } }), opts)?.context).toBe('safari-private')
    expect(attestFrame(sender({ tab: { id: 1, incognito: false } }), opts)?.context).toBe('safari')
  })
})
