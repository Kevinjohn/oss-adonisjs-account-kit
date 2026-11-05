import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import AnimatedRecording from './components/animated_recording.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('AnimatedRecording', AnimatedRecording)
  },
} satisfies Theme
