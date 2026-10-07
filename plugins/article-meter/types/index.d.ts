export type PartCount = { part: number; words: number }

export type MarkerCount = { marker: string; count: number }

export type ArticleMeter = {
  // The draft's path, relative to the project when it lies inside it.
  file: string
  // How often each "work left" marker appears outside HTML comments.
  markers: MarkerCount[]
  // Words per numbered part (`## 1. …`), outside fences, tables, images and headings.
  parts: PartCount[]
  // The focus part's words over all numbered parts' words, 0 to 1.
  focusShare: number
  // Set when no draft was found or it could not be read.
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'article-meter': { meter: ArticleMeter | null }
  }
}
