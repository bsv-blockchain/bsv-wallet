import { sampleScreenGradient } from '../../ui/components/ui/ScrollFade'

// The fade is painted in the backdrop's own colour. Sampling the wrong point of
// the screen gradient is what makes a fade band against what is behind it.
describe('sampleScreenGradient', () => {
  it('is the start colour at the top', () => {
    expect(sampleScreenGradient('#000000', '#ffffff', 0, 320)).toBe('#000000')
  })

  it('is the end colour at and below the gradient height', () => {
    expect(sampleScreenGradient('#000000', '#ffffff', 320, 320)).toBe('#ffffff')
    expect(sampleScreenGradient('#000000', '#ffffff', 900, 320)).toBe('#ffffff')
  })

  it('interpolates in between', () => {
    expect(sampleScreenGradient('#000000', '#ffffff', 160, 320)).toBe('#808080')
  })

  it('matches the real light canvas at a plausible header height', () => {
    // canvasTop -> canvasBase over 360, sampled where the pinned block ends.
    expect(sampleScreenGradient('#EAECF1', '#F5F6F9', 300, 360)).toBe('#f3f4f8')
  })

  it('falls back to the flat base for a colour it cannot parse', () => {
    expect(sampleScreenGradient('rgba(0,0,0,0.5)', '#F5F6F9', 10, 360)).toBe('#F5F6F9')
    expect(sampleScreenGradient('#EAECF1', '#F5F6F9', 10, 0)).toBe('#F5F6F9')
  })
})
