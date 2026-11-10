export type NitpickerRun = {
  round: number
  pending?: string
  isDirty: boolean
  history: string[]
  reviewers: string[]
}

declare module 'claude-code' {
  interface PluginState {
    nitpicker: { run: Shaped<NitpickerRun> }
  }
}
