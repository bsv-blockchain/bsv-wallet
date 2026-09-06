import { Image } from 'expo-image'

export default async (url: string): Promise<boolean> => {
  try {
    return await Image.prefetch(url)
  } catch {
    return false
  }
}
