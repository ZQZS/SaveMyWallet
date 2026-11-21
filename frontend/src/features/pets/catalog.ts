import cat from '../../../resources/pets/wallet-cat/manifest.json' with { type: 'json' }
import catLines from '../../../resources/pets/wallet-cat/lines.json' with { type: 'json' }
import owl from '../../../resources/pets/ledger-owl/manifest.json' with { type: 'json' }
import owlLines from '../../../resources/pets/ledger-owl/lines.json' with { type: 'json' }
import fox from '../../../resources/pets/detective-fox/manifest.json' with { type: 'json' }
import foxLines from '../../../resources/pets/detective-fox/lines.json' with { type: 'json' }
import type { AppLocale } from '../../i18n/index.ts'
import type { PetManifest } from './manifest.ts'

export interface PetCharacter {
  id: string
  name: string
  description: string
  avatar: string
  greetAvatar?: string
  greetings: string[]
  dialogueExample?: string
  reminderLine?: string
  preview: string
  lowBalance?: string
  pendingEstimates?: string
  imported?: boolean
}

const packs: { manifest: Pick<PetManifest, 'id' | 'states'>; lines: typeof catLines }[] = [
  { manifest: cat, lines: catLines },
  { manifest: owl, lines: owlLines },
  { manifest: fox, lines: foxLines },
]

function artworkUrl(id: string, path: string): string {
  // The bundled packs keep their art one directory below the manifest. Vite
  // needs each path segment in the template to discover files at build time.
  const [folder, file] = path.split('/')
  return new URL(`../../../resources/pets/${id}/${folder}/${file}`, import.meta.url).href
}

export function builtinPets(locale: AppLocale): PetCharacter[] {
  const exampleMonth = locale === 'zh-CN' ? '11 月' : 'November'
  return packs.map(({ manifest, lines }) => {
    const dialogue = lines[locale]
    return {
      id: manifest.id,
      ...dialogue,
      avatar: artworkUrl(manifest.id, manifest.states.idle),
      greetAvatar: artworkUrl(manifest.id, manifest.states.greet ?? manifest.states.idle),
      preview: dialogue.pendingEstimates.replace('{month}', exampleMonth).replace('{count}', '2'),
    }
  })
}
