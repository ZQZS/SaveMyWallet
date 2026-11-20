export interface PetManifest {
  version: 1
  id: string
  displayName: string
  artworkSource: string
  /** 资源路径相对于同一图包的 manifest.json。 */
  states: {
    idle: string
    greet?: string
    remind?: string
  }
}

export type PetState = keyof PetManifest['states']

export function assetForState(pet: PetManifest, state: PetState): string {
  return pet.states[state] ?? pet.states.idle
}
